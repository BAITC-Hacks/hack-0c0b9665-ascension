// Keep imported free text as text when a queue is opened in a spreadsheet.
export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\uFEFF]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function csvDocument(rows) {
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(';')).join('\r\n');
}

export function downloadCsv(filename, rows) {
  const url = URL.createObjectURL(new Blob([csvDocument(rows)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
