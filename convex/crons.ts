import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "cleanup expired channel dedup claims",
  { hours: 1 },
  internal.channelDedup.cleanupExpired,
  {},
);

export default crons;
