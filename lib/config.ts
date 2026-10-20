/**
 * Runtime configuration. Every brand string, hostname and timezone that the
 * production system hardcoded lives here instead, read from the environment
 * with obviously-fake defaults so the repo runs offline.
 */

export interface AppConfig {
  /** Customer-facing business name used in SMS/email copy. */
  brandName: string;
  /** IANA timezone the studio operates in (business hours, reminders). */
  timezone: string;
  hosts: {
    /** Staff CRM, e.g. crm.example.com */
    staff: string;
    /** Customer booking portal, e.g. book.example.com */
    booking: string;
    /** Public marketing site(s), e.g. example.com, www.example.com */
    marketing: string[];
  };
  /** Trusted public origin used to rebuild webhook URLs for signature checks. */
  publicUrl: string;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): AppConfig {
  const marketing = (env.MARKETING_HOSTS ?? "example.com,www.example.com")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return {
    brandName: env.BRAND_NAME?.trim() || "Acme Wellness Studio",
    timezone: env.APP_TIMEZONE?.trim() || "America/Los_Angeles",
    hosts: {
      staff: (env.STAFF_HOST ?? "crm.example.com").toLowerCase(),
      booking: (env.BOOKING_HOST ?? "book.example.com").toLowerCase(),
      marketing,
    },
    publicUrl: env.PUBLIC_URL?.replace(/\/$/, "") || "https://crm.example.com",
  };
}

/** Default-off feature flag: only the literal "true" enables it. */
export function envFlagDefaultOff(name: string, env: Env = process.env): boolean {
  return env[name] === "true";
}

/** Default-on kill switch: only the literal "false" disables it. */
export function envFlagDefaultOn(name: string, env: Env = process.env): boolean {
  return env[name] !== "false";
}
