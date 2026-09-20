import React from "react";
import ReactDOM from "react-dom/client";
import { ArenaApp } from "./arena/ArenaApp";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ArenaApp />
  </React.StrictMode>,
);
