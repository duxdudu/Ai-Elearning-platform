import { loadServicePort } from "@lumen/config";
import { createServiceApp, startService } from "@lumen/http";

const name = "notification-service";
const app = createServiceApp({ name });
await startService(app, name, loadServicePort("NOTIFICATION_WORKER_PORT", 4106));
