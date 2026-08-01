import { env } from "./config.js";

export type NewKeycloakUser = {
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  password: string;
};

export class KeycloakAdminError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

const issuer = env.KEYCLOAK_ISSUER.replace(/\/$/, "");
const issuerUrl = new URL(issuer);
const realmMarker = "/realms/";
const markerIndex = issuerUrl.pathname.lastIndexOf(realmMarker);
if (markerIndex < 0) throw new Error("KEYCLOAK_ISSUER must end with /realms/{realm}");
const realm = decodeURIComponent(issuerUrl.pathname.slice(markerIndex + realmMarker.length));
const keycloakBase = `${issuerUrl.origin}${issuerUrl.pathname.slice(0, markerIndex)}`;
const usersEndpoint = `${keycloakBase}/admin/realms/${encodeURIComponent(realm)}/users`;

export async function createKeycloakUser(accessToken: string, input: NewKeycloakUser): Promise<string> {
  const response = await fetch(usersEndpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      username: input.username,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      enabled: true,
      emailVerified: false,
      credentials: [{ type: "password", value: input.password, temporary: false }],
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 409) throw new KeycloakAdminError("A user with that username or email already exists", 409);
  if (response.status === 401 || response.status === 403) throw new KeycloakAdminError("You do not have permission to add users", 403);
  if (response.status !== 201) throw new KeycloakAdminError("Could not add the user", 502);
  const location = response.headers.get("location");
  const userId = location?.split("/").filter(Boolean).pop();
  if (!userId) throw new KeycloakAdminError("Could not finish adding the user", 502);
  return userId;
}

export async function deleteKeycloakUser(accessToken: string, userId: string) {
  await fetch(`${usersEndpoint}/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => undefined);
}
