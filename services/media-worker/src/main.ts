import { loadServicePort } from "@lumen/config";
import { createServiceApp, startService } from "@lumen/http";

const name = "media-worker";
const app = createServiceApp({ name });
await startService(app, name, loadServicePort("MEDIA_WORKER_PORT", 4104));
