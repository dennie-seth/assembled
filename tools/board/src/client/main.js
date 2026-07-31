import { createApp } from "./app.js";

const boardRoot = document.getElementById("board");

const app = createApp({ boardRoot });
app.init();
