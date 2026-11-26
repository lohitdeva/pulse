import { createIngestTimetableHandler } from "./handler.ts";

Deno.serve(
  createIngestTimetableHandler({
    readEnv: (name) => Deno.env.get(name),
  }),
);
