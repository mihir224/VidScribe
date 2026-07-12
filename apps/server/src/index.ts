import { config } from "./config.js";
import { buildApp } from "./app.js";

try {
  const app = await buildApp();
  await app.listen({
    port: config.port,
    host: config.host
  });
} catch (error) {
  console.error(error);
  process.exit(1);
}
