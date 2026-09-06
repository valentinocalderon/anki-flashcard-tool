import { createCallerFactory, createTRPCRouter } from "@/server/api/trpc";
import { ankiRouter } from "./routers/lookupRouter";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  anki: ankiRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 * @example
 * const trpc = createCaller(createContext);
 * const res = await trpc.anki.generateFromList({ text: 'casa' });
 */
export const createCaller = createCallerFactory(appRouter);
