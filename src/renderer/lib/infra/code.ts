/**
 * The infrastructure layer code that start-up does not need: parsers,
 * clustering, route matching, site and satellite cards. The infra store imports this
 * module with the first layer data (`useInfraStore().code`), so with every
 * layer off it is never loaded.
 */
export {
  parseCloudRegions,
  parsePeeringDbSites,
  parseSatelliteGroup,
  parseSubmarineCables
} from "./sources";
export {
  buildSiteClusters,
  cableLines,
  cableSpecs,
  infraScene,
  keepUnchanged,
  routeInfra,
  siteSpecKey
} from "./scene";
export { siteCardContent } from "./siteCard";
export { satelliteDrawing } from "../satellites/scene";
export { satelliteCardContent } from "../satellites/card";

export type InfraCode = typeof import("./code");
