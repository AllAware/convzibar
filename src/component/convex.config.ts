import { defineComponent } from "convex/server";
import workpool from "@convex-dev/workpool/convex.config";

const component = defineComponent("convex_rebac");
component.use(workpool);

export default component;
