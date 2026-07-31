import { createApp } from "./app.js";

const boardRoot = document.getElementById("board");
const detailRoot = document.getElementById("detail");

const app = createApp({ boardRoot, detailRoot });
app.init();
