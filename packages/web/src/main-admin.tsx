import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { Providers } from "./app/providers.js";
import { router } from "./app/router-admin.js";
import { registerAdminI18n } from "./shared/i18n/admin.js";
import "./shared/theme/tokens.css";

registerAdminI18n();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </React.StrictMode>,
);
