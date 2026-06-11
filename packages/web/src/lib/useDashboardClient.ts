import { useMemo } from "react";

import { createDashboardApiClient } from "./dashboard-api";

export const useDashboardClient = () => {
  const client = useMemo(() => createDashboardApiClient(), []);

  return {
    client,
  };
};
