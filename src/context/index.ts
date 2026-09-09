import { ContextService } from "./contextService";
import { DateTimeProvider } from "./providers/dateTimeProvider";
import { SystemInfoProvider } from "./providers/systemInfoProvider";

export { ContextService } from "./contextService";
export * from "./types";
export { DateTimeProvider } from "./providers/dateTimeProvider";
export { SystemInfoProvider } from "./providers/systemInfoProvider";

/**
 * The application's single ContextService instance, pre-registered with
 * the providers NIMBUS ships with today. Future providers (weather,
 * email, calendar, ...) get registered here too, each in its own module
 * under src/context/providers — nothing else about this file changes.
 */
export const contextService = new ContextService();
contextService.register(new DateTimeProvider());
contextService.register(new SystemInfoProvider());
