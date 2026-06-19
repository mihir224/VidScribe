import cors from "@fastify/cors";
import Fastify from "fastify";
import {
  generateNotesRequestSchema,
  noteJobSchema
} from "@vidscribe/shared";
import { ZodError } from "zod";
import { config } from "./config.js";
import { NotesJobStore } from "./jobs.js";

const app = Fastify({
  logger: true
});

const jobs = new NotesJobStore();

await app.register(cors, {
  origin: true
});

app.get("/health", async () => ({
  ok: true,
  service: "vidscribe-server"
}));

app.post("/api/notes/jobs", async (request, reply) => {
  try {
    const body = generateNotesRequestSchema.parse(request.body);
    const job = jobs.create(body);
    return reply.code(202).send(noteJobSchema.parse(job));
  } catch (error) {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Invalid request body",
        issues: error.issues
      });
    }

    throw error;
  }
});

app.get("/api/notes/jobs/:jobId", async (request, reply) => {
  const params = request.params as { jobId?: string };
  const jobId = params.jobId;

  if (!jobId) {
    return reply.code(400).send({ error: "Missing jobId" });
  }

  const job = jobs.get(jobId);
  if (!job) {
    return reply.code(404).send({ error: "Job not found" });
  }

  return noteJobSchema.parse(job);
});

try {
  await app.listen({
    port: config.port,
    host: config.host
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
