import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import App from "./App";
import { ToastProvider } from "./hooks/useToast";
import { SSEProvider } from "./contexts/SSEContext";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <SSEProvider>
          <App />
        </SSEProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
