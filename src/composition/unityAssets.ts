import { UnityAssetsService } from "../application/unity/UnityAssetsService.js";
import { UnityAssetsProvider } from "../unity/UnityAssetsProvider.js";

/** Compose bundled offline inspection without acquiring Unity or starting any process. */
export const createUnityAssetsService = (): UnityAssetsService =>
  new UnityAssetsService(new UnityAssetsProvider());
