import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Ez olvassa ki a .env fájlodból a Vercel URL-t
    url: process.env.DATABASE_URL, 
  },
});