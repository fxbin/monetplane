import { cookies } from "next/headers";
import { getApplicationList } from "@/modules/admin/queries";

export const CONSOLE_APPLICATION_COOKIE = "monetplane_console_application";
export const CONSOLE_ENVIRONMENT_COOKIE = "monetplane_console_environment";

export type ConsoleEnvironment = "test" | "live";

export type ConsoleApplication = {
  id: string;
  slug: string;
  name: string;
  status: string;
};

export type ConsoleContext = {
  applications: ConsoleApplication[];
  selectedApplication: ConsoleApplication | null;
  environment: ConsoleEnvironment;
};

function isConsoleEnvironment(value: string | undefined): value is ConsoleEnvironment {
  return value === "test" || value === "live";
}

export async function getConsoleContext(): Promise<ConsoleContext> {
  const [applicationRows, cookieStore] = await Promise.all([
    getApplicationList(),
    cookies(),
  ]);

  const applications = applicationRows.filter(
    (application) => application.status === "active",
  );
  const requestedApplicationId = cookieStore.get(CONSOLE_APPLICATION_COOKIE)?.value;
  const requestedEnvironment = cookieStore.get(CONSOLE_ENVIRONMENT_COOKIE)?.value;

  const selectedApplication =
    applications.find((application) => application.id === requestedApplicationId) ??
    applications[0] ??
    null;

  return {
    applications,
    selectedApplication,
    environment: isConsoleEnvironment(requestedEnvironment)
      ? requestedEnvironment
      : "test",
  };
}
