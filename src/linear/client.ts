// ---------------------------------------------------------------------------
// Linear GraphQL API client
// ---------------------------------------------------------------------------

const LINEAR_API_URL = "https://api.linear.app/graphql";
const MAX_RETRIES = 3;
const RATE_LIMIT_WARN_THRESHOLD = 500;
const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  priority: number;
  state: { id: string; name: string; type: string };
  teamId: string;
  projectId: string;
  relations: { type: string; issueId: string; issueIdentifier: string }[];
  inverseRelations: {
    type: string;
    issueId: string;
    issueIdentifier: string;
  }[];
}

/** Maps state name (e.g. "In Progress", "In Review") to { id, type }. */
export type WorkflowStateMap = Map<string, { id: string; type: string }>;

export interface ProjectMetadata {
  id: string;
  description: string;
  teamIds: string[];
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[orca/linear] ${message}`);
}

function warn(message: string): void {
  console.log(`[orca/linear] warning: ${message}`);
}

// ---------------------------------------------------------------------------
// Sleep helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class LinearClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("LinearClient: API key is required");
    }
    this.apiKey = apiKey;
  }

  // -------------------------------------------------------------------------
  // Private: typed GraphQL request helper (2.1)
  // -------------------------------------------------------------------------

  private async query<T>(
    graphql: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: 1s, 2s, 4s
        const delayMs = Math.pow(2, attempt - 1) * 1000;
        log(`retrying request (attempt ${attempt}/${MAX_RETRIES}) after ${delayMs}ms`);
        await sleep(delayMs);
      }

      let response: Response;
      try {
        response = await fetch(LINEAR_API_URL, {
          method: "POST",
          headers: {
            Authorization: this.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: graphql, variables }),
        });
      } catch (err) {
        // Network error -- transient, retry
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          continue;
        }
        throw new Error(
          `LinearClient: network error after ${MAX_RETRIES + 1} attempts: ${lastError.message}`,
        );
      }

      // Rate limit monitoring (2.5)
      const remaining = response.headers.get("X-RateLimit-Requests-Remaining");
      if (remaining !== null) {
        const remainingNum = parseInt(remaining, 10);
        if (!Number.isNaN(remainingNum) && remainingNum < RATE_LIMIT_WARN_THRESHOLD) {
          warn(`rate limit low (${remainingNum} remaining)`);
        }
      }

      // Auth errors -- do NOT retry
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `LinearClient: authentication failed (HTTP ${response.status}). ` +
            `Check that ORCA_LINEAR_API_KEY is valid.`,
        );
      }

      // Transient errors -- retry
      if (TRANSIENT_STATUS_CODES.has(response.status)) {
        lastError = new Error(
          `LinearClient: HTTP ${response.status} from Linear API`,
        );
        if (attempt < MAX_RETRIES) {
          continue;
        }
        throw new Error(
          `LinearClient: HTTP ${response.status} after ${MAX_RETRIES + 1} attempts`,
        );
      }

      // Other client errors -- do NOT retry
      if (!response.ok) {
        const body = await response.text().catch(() => "(unreadable body)");
        throw new Error(
          `LinearClient: HTTP ${response.status}: ${body}`,
        );
      }

      // Parse JSON response
      const json = (await response.json()) as {
        data?: T;
        errors?: { message: string }[];
      };

      if (json.errors && json.errors.length > 0) {
        const messages = json.errors.map((e) => e.message).join("; ");
        throw new Error(`LinearClient: GraphQL errors: ${messages}`);
      }

      if (!json.data) {
        throw new Error("LinearClient: response missing data field");
      }

      return json.data;
    }

    // Should not reach here, but satisfy TypeScript
    throw lastError ?? new Error("LinearClient: unexpected retry loop exit");
  }

  // -------------------------------------------------------------------------
  // 2.2 fetchProjectIssues
  // -------------------------------------------------------------------------

  async fetchProjectIssues(projectIds: string[]): Promise<LinearIssue[]> {
    if (projectIds.length === 0) {
      return [];
    }

    const graphql = `
      query($projectIds: [ID!]!, $after: String) {
        issues(filter: { project: { id: { in: $projectIds } } }, first: 25, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            identifier
            title
            description
            priority
            state { id name type }
            team { id }
            project { id }
            relations { nodes { type relatedIssue { id identifier } } }
            inverseRelations { nodes { type issue { id identifier } } }
          }
        }
      }
    `;

    const allIssues: LinearIssue[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const variables: Record<string, unknown> = { projectIds };
      if (cursor) {
        variables.after = cursor;
      }

      const data = await this.query<{
        issues: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            id: string;
            identifier: string;
            title: string;
            description: string | null;
            priority: number;
            state: { id: string; name: string; type: string };
            team: { id: string };
            project: { id: string };
            relations: {
              nodes: Array<{
                type: string;
                relatedIssue: { id: string; identifier: string };
              }>;
            };
            inverseRelations: {
              nodes: Array<{
                type: string;
                issue: { id: string; identifier: string };
              }>;
            };
          }>;
        };
      }>(graphql, variables);

      for (const node of data.issues.nodes) {
        allIssues.push({
          id: node.id,
          identifier: node.identifier,
          title: node.title,
          description: node.description ?? "",
          priority: node.priority,
          state: node.state,
          teamId: node.team.id,
          projectId: node.project.id,
          relations: node.relations.nodes.map((r) => ({
            type: r.type,
            issueId: r.relatedIssue.id,
            issueIdentifier: r.relatedIssue.identifier,
          })),
          inverseRelations: node.inverseRelations.nodes.map((r) => ({
            type: r.type,
            issueId: r.issue.id,
            issueIdentifier: r.issue.identifier,
          })),
        });
      }

      hasNextPage = data.issues.pageInfo.hasNextPage;
      cursor = data.issues.pageInfo.endCursor;
    }

    log(`fetched ${allIssues.length} issues from ${projectIds.length} project(s)`);
    return allIssues;
  }

  // -------------------------------------------------------------------------
  // 2.2b fetchProjectMetadata
  // -------------------------------------------------------------------------

  /**
   * Fetch project descriptions and team IDs in a single query.
   * Used at startup to build the per-project repo map and resolve team IDs.
   */
  async fetchProjectMetadata(
    projectIds: string[],
  ): Promise<ProjectMetadata[]> {
    if (projectIds.length === 0) return [];

    const graphql = `
      query($projectIds: [ID!]!) {
        projects(filter: { id: { in: $projectIds } }, first: 50) {
          nodes { id description content teams { nodes { id } } }
        }
      }
    `;

    const data = await this.query<{
      projects: {
        nodes: Array<{
          id: string;
          description: string | null;
          content: string | null;
          teams: { nodes: Array<{ id: string }> };
        }>;
      };
    }>(graphql, { projectIds });

    const results: ProjectMetadata[] = data.projects.nodes.map((p) => ({
      id: p.id,
      description: p.content || p.description || "",
      teamIds: p.teams.nodes.map((t) => t.id),
    }));

    log(
      `fetched metadata for ${results.length} project(s) ` +
        `(${new Set(results.flatMap((p) => p.teamIds)).size} team(s))`,
    );
    return results;
  }

  // -------------------------------------------------------------------------
  // 2.3 fetchTeamIdsForProjects
  // -------------------------------------------------------------------------

  /**
   * Fetch the unique team IDs associated with the given project IDs.
   */
  async fetchTeamIdsForProjects(projectIds: string[]): Promise<string[]> {
    if (projectIds.length === 0) return [];

    const graphql = `
      query($projectIds: [ID!]!) {
        projects(filter: { id: { in: $projectIds } }, first: 50) {
          nodes { teams { nodes { id } } }
        }
      }
    `;

    const data = await this.query<{
      projects: {
        nodes: Array<{ teams: { nodes: Array<{ id: string }> } }>;
      };
    }>(graphql, { projectIds });

    const teamIds = new Set<string>();
    for (const project of data.projects.nodes) {
      for (const team of project.teams.nodes) {
        teamIds.add(team.id);
      }
    }

    log(`resolved ${teamIds.size} team(s) from ${projectIds.length} project(s)`);
    return [...teamIds];
  }

  // -------------------------------------------------------------------------
  // 2.4 fetchWorkflowStates
  // -------------------------------------------------------------------------

  /**
   * Fetch workflow states for the given team IDs and return a map from
   * state name to { id, type }.
   *
   * When multiple teams are provided, states are merged with last-team-wins
   * semantics for conflicting state names.
   */
  async fetchWorkflowStates(teamIds: string[]): Promise<WorkflowStateMap> {
    if (teamIds.length === 0) {
      return new Map();
    }

    const graphql = `
      query($teamId: String!) {
        team(id: $teamId) {
          states { nodes { id name type } }
        }
      }
    `;

    const stateMap: WorkflowStateMap = new Map();

    for (const teamId of teamIds) {
      const data = await this.query<{
        team: {
          states: {
            nodes: Array<{ id: string; name: string; type: string }>;
          };
        };
      }>(graphql, { teamId });

      for (const state of data.team.states.nodes) {
        stateMap.set(state.name, { id: state.id, type: state.type });
      }
    }

    log(
      `fetched workflow states from ${teamIds.length} team(s): ` +
        `${stateMap.size} state(s)`,
    );
    return stateMap;
  }

  // -------------------------------------------------------------------------
  // 2.4 updateIssueState
  // -------------------------------------------------------------------------

  async createComment(issueId: string, body: string): Promise<boolean> {
    const graphql = `
      mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }
    `;

    const data = await this.query<{
      commentCreate: { success: boolean };
    }>(graphql, { issueId, body });

    return data.commentCreate.success;
  }

  async createAttachment(issueId: string, url: string, title: string): Promise<boolean> {
    const graphql = `
      mutation($issueId: String!, $url: String!, $title: String!) {
        attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) {
          success
        }
      }
    `;

    const data = await this.query<{
      attachmentCreate: { success: boolean };
    }>(graphql, { issueId, url, title });

    return data.attachmentCreate.success;
  }

  async updateIssueState(issueId: string, stateId: string): Promise<boolean> {
    const graphql = `
      mutation($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) {
          success
        }
      }
    `;

    const data = await this.query<{
      issueUpdate: { success: boolean };
    }>(graphql, { issueId, stateId });

    return data.issueUpdate.success;
  }
}
