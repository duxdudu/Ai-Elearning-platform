import { loadServicePort } from "@lumen/config";
import { createServiceApp, startService } from "@lumen/http";

const name = "ai-service";
const app = createServiceApp({ name });
await startService(app, name, loadServicePort("AI_SERVICE_PORT", 4105));
