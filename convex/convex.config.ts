import { defineApp } from "convex/server";
import rebac from "../src/component/convex.config.js";

const app = defineApp();
app.use(rebac);
export default app;
