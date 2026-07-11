import { createContext, useContext, type ReactNode } from "react";

import type { DashboardApiClient } from "./dashboard-api";
import { useDashboardClient } from "./useDashboardClient";
import { useDashboardOverview } from "./useDashboardOverview";

type DashboardDataContextValue = ReturnType<typeof useDashboardOverview> & {
  client: DashboardApiClient;
};

const DashboardDataContext = createContext<DashboardDataContextValue | null>(null);

export const DashboardDataProvider = ({ children }: { children: ReactNode }) => {
  const { client } = useDashboardClient();
  const overviewState = useDashboardOverview({ client });

  return (
    <DashboardDataContext.Provider value={{ client, ...overviewState }}>
      {children}
    </DashboardDataContext.Provider>
  );
};

export const useDashboardData = (): DashboardDataContextValue => {
  const context = useContext(DashboardDataContext);
  if (!context) {
    throw new Error("useDashboardData must be used within DashboardDataProvider");
  }
  return context;
};
