import { useMemo, useState } from "react";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowUpDown } from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { type PositionTableRow, formatCurrency, formatNumber, formatSignedCurrency } from "../lib/admin";

export const PositionsTable = ({
  rows,
  showAgent = true,
  emptyMessage = "No positions match current filters.",
}: {
  rows: PositionTableRow[];
  showAgent?: boolean;
  emptyMessage?: string;
}) => {
  const [sorting, setSorting] = useState<SortingState>([{ id: "marketValue", desc: true }]);

  const columns = useMemo<ColumnDef<PositionTableRow>[]>(() => {
    const base: ColumnDef<PositionTableRow>[] = [];

    if (showAgent) {
      base.push({
        accessorKey: "userName",
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="h-auto p-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Agent
            <ArrowUpDown className="ml-1 h-3 w-3" />
          </Button>
        ),
        cell: ({ row }) => (
          <div className="space-y-0.5">
            <p className="font-medium">{row.original.userName}</p>
            <p className="font-mono text-xs text-muted-foreground">{row.original.accountName ?? "default-account"}</p>
          </div>
        ),
      });
    }

    base.push(
      {
        accessorKey: "market",
        header: () => "Market / Symbol",
        cell: ({ row }) => (
          <div className="space-y-0.5">
            <Badge variant="secondary" className="w-fit border border-border/50">
              {row.original.market}
            </Badge>
            {row.original.symbolName ? (
              <>
                <p className="text-xs text-foreground/80 truncate max-w-[300px]" title={row.original.symbolName}>
                  {row.original.symbolName}
                </p>
                <p className="font-mono text-[10px] text-muted-foreground/60 truncate max-w-[200px]" title={row.original.symbol}>
                  {row.original.symbol}
                </p>
              </>
            ) : (
              <p className="font-mono text-xs text-muted-foreground">{row.original.symbol}</p>
            )}
          </div>
        ),
      },
      {
        accessorKey: "side",
        header: () => "Outcome (Yes/No)",
        cell: ({ row }) => {
          const side = row.original.side;
          if (!side) return <span className="text-muted-foreground text-xs">Unknown</span>;
          const normalizedSide = side.toLowerCase();
          const isYes = normalizedSide === "yes";
          const isNo = normalizedSide === "no";
          return (
            <Badge
              variant="outline"
              className={
                isYes
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : isNo
                    ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                    : "border-border/60 bg-muted/40 text-muted-foreground"
              }
            >
              {side}
            </Badge>
          );
        },
      },
      {
        accessorKey: "quantity",
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="h-auto p-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Quantity
            <ArrowUpDown className="ml-1 h-3 w-3" />
          </Button>
        ),
        cell: ({ row }) => <span className="font-medium">{formatNumber(row.original.quantity)}</span>,
      },
      {
        accessorKey: "avgCost",
        header: "Avg Cost",
        cell: ({ row }) => <span className="font-mono text-xs">{formatCurrency(row.original.avgCost)}</span>,
      },
      {
        accessorKey: "currentPrice",
        header: "Mark",
        cell: ({ row }) => <span className="font-mono text-xs">{formatCurrency(row.original.currentPrice)}</span>,
      },
      {
        accessorKey: "marketValue",
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="h-auto p-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Value
            <ArrowUpDown className="ml-1 h-3 w-3" />
          </Button>
        ),
        cell: ({ row }) => <span className="font-semibold">{formatCurrency(row.original.marketValue)}</span>,
      },
      {
        accessorKey: "unrealizedPnl",
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="h-auto p-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            PnL
            <ArrowUpDown className="ml-1 h-3 w-3" />
          </Button>
        ),
        cell: ({ row }) => {
          const value = row.original.unrealizedPnl;
          if (value === null) {
            return <span className="text-muted-foreground">N/A</span>;
          }

          return (
            <span className={value >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
              {formatSignedCurrency(value)}
            </span>
          );
        },
      },
    );

    return base;
  }, [showAgent]);

  const table = useReactTable({
    data: rows,
    columns,
    state: {
      sorting,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <Table className="min-w-[760px]">
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <TableHead key={header.id}>
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.length > 0 ? (
          table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
              ))}
            </TableRow>
          ))
        ) : (
          <TableRow>
            <TableCell colSpan={columns.length} className="h-16 text-center text-muted-foreground">
              {emptyMessage}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
};
