import * as XLSX from 'xlsx';

export const IMPORT_HEADERS = [
  'budget',
  'data',
  'tipo',
  'importo',
  'categoria',
  'metodo_conto',
  'descrizione',
  'incassata',
  'ricorrente',
  'frequenza',
  'giorno_ricorrenza',
];
const REQUIRED_IMPORT_HEADERS = IMPORT_HEADERS.filter((header) => header !== 'metodo_conto');

const clean = (value) => String(value ?? '').trim();
const normalizeHeader = (value) => clean(value).toLowerCase().replace(/\s+/g, '_');
const normalizeToken = (value) => clean(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const parseExcelDate = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed?.y && parsed?.m && parsed?.d) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const text = clean(value);
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) return `${match[3]}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
  return text;
};

const parseLocalizedNumber = (value) => {
  if (typeof value === 'number') return value;
  const text = clean(value).replace(/€|EUR/gi, '').replace(/\s/g, '');
  if (!text) return NaN;
  const normalized = text.includes(',') && text.includes('.')
    ? (text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, ''))
    : text.replace(',', '.');
  return Number(normalized);
};

const parseYesNo = (value) => {
  const token = normalizeToken(value);
  if (!token) return null;
  if (['si', 's', 'yes', 'y', 'true', '1'].includes(token)) return true;
  if (['no', 'n', 'false', '0'].includes(token)) return false;
  return undefined;
};

const isValidIsoDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export async function parseMovementWorkbook(file) {
  const bytes = await file.arrayBuffer();
  const workbook = XLSX.read(bytes, { type: 'array', cellDates: true, raw: false });
  const preferredSheet = workbook.SheetNames.find((name) => normalizeHeader(name).replace(/_/g, '') === 'importmovimenti');
  const sheetName = preferredSheet || workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) return { fileName: file.name, sheetName: '', rows: [], errors: [{ row: null, message: 'Il file non contiene un foglio leggibile.' }] };

  const matrix = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: false });
  const headerIndex = matrix.findIndex((row) => {
    const values = row.map(normalizeHeader);
    return REQUIRED_IMPORT_HEADERS.every((header) => values.includes(header));
  });
  if (headerIndex < 0) {
    return {
      fileName: file.name,
      sheetName,
      rows: [],
      errors: [{ row: null, message: `Intestazioni non riconosciute. Servono: ${REQUIRED_IMPORT_HEADERS.join(', ')}. La colonna metodo_conto è facoltativa: se vuota usa “Non specificato”.` }],
    };
  }

  const headerMap = new Map(matrix[headerIndex].map((value, index) => [normalizeHeader(value), index]));
  const rows = [];
  for (let index = headerIndex + 1; index < matrix.length; index += 1) {
    const source = matrix[index];
    if (!source.some((value) => clean(value))) continue;
    rows.push({
      sourceRow: index + 1,
      budget: clean(source[headerMap.get('budget')]),
      date: parseExcelDate(source[headerMap.get('data')]),
      type: normalizeToken(source[headerMap.get('tipo')]),
      amount: parseLocalizedNumber(source[headerMap.get('importo')]),
      category: clean(source[headerMap.get('categoria')]),
      paymentMethod: clean(source[headerMap.get('metodo_conto')]),
      description: clean(source[headerMap.get('descrizione')]),
      received: parseYesNo(source[headerMap.get('incassata')]),
      recurring: parseYesNo(source[headerMap.get('ricorrente')]),
      frequency: normalizeToken(source[headerMap.get('frequenza')]),
      recurringDay: clean(source[headerMap.get('giorno_ricorrenza')]),
    });
  }
  return { fileName: file.name, sheetName, rows, errors: [] };
}

export { isValidIsoDate };
