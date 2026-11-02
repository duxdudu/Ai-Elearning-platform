import { loadServicePort } from "@lumen/config";
import { createServiceApp, startService } from "@lumen/http";

const name = "analytics-service";
const app = createServiceApp({ name });
await startService(app, name, loadServicePort("ANALYTICS_SERVICE_PORT", 4107));
