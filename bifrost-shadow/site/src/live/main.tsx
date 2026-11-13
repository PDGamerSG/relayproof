import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "../styles/base.css";
import "./live.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LiveApp } from "./LiveApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LiveApp />
  </StrictMode>,
);
