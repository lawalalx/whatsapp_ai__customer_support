// Singleton PostgresStore shared across all agents and the Mastra instance.
// This avoids spinning up separate connection pools for every agent module,
// which was the primary cause of memory exhaustion on Render's free tier.
import "dotenv/config";
import { PostgresStore } from "@mastra/pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

export const sharedPgStore = new PostgresStore({
  id: "shared-pg-storage",
  connectionString: process.env.DATABASE_URL,
  // Keep the connection pool small for low-memory environments.
  // Render free tier: 512 MB RAM — each idle PG connection costs ~5–8 MB.
  max: 3,
});
