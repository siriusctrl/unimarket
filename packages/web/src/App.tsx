import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import { DashboardDataProvider } from "./lib/dashboard-data";
import { AgentDetailPage } from "./pages/AgentDetailPage";
import { AnalysisPage } from "./pages/AnalysisPage";
import { DashboardPage } from "./pages/DashboardPage";

export const App = () => {
  return (
    <BrowserRouter>
      <DashboardDataProvider>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route element={<Layout />}>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/agents/:id" element={<AgentDetailPage />} />
            <Route path="/analysis/:market/:reference" element={<AnalysisPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </DashboardDataProvider>
    </BrowserRouter>
  );
};
