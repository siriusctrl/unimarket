import { Card, CardContent } from "./ui/card";

export const LoadingState = ({ label = "Loading review snapshot..." }: { label?: string }) => {
  return (
    <Card className="border-primary/20 animate-in fade-in-0 duration-300">
      <CardContent className="space-y-5 py-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="mb-2 h-3 w-28 animate-pulse rounded-sm bg-muted" />
            <p className="text-sm text-muted-foreground">{label}</p>
          </div>
          <div className="h-9 w-24 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="h-24 animate-pulse rounded-md bg-muted/80" />
          <div className="h-24 animate-pulse rounded-md bg-muted/70" />
          <div className="h-24 animate-pulse rounded-md bg-muted/60" />
        </div>
        <div className="h-56 animate-pulse rounded-md border border-border/60 bg-muted/55" />
      </CardContent>
    </Card>
  );
};
