/**
 * Generic server-rendered data table.
 *
 * Wraps the shared `.data-table` styles with typed column definitions so
 * console pages declare structure once instead of repeating table markup.
 * Pass React nodes (including <StatusBadge />) through the cell renderers.
 */

import type { ReactNode } from "react";

export type DataTableColumn<Row> = {
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  className?: string;
};

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  wrap = true,
}: {
  columns: Array<DataTableColumn<Row>>;
  rows: Row[];
  rowKey: (row: Row) => string;
  wrap?: boolean;
}) {
  const table = (
    <table className="data-table">
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key}>{column.header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((column) => (
              <td key={column.key} className={column.className}>
                {column.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );

  if (!wrap) return table;
  return <div className="table-wrapper">{table}</div>;
}
