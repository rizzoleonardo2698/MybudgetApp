const escapeXml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const columnName = (index) => {
  let name = '';
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
};

const excelSerial = (value) => {
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return '';
  return Math.round((Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()) - Date.UTC(1899, 11, 30)) / 86400000);
};

const stylesFor = (kind = 'text', tone = '') => {
  if (tone === 'planned') return kind === 'date' ? 6 : kind === 'currency' ? 5 : 4;
  if (tone === 'income') return kind === 'date' ? 9 : kind === 'currency' ? 8 : 7;
  if (tone === 'expense') return kind === 'date' ? 12 : kind === 'currency' ? 11 : 10;
  if (kind === 'date') return 3;
  if (kind === 'currency') return 2;
  if (kind === 'total') return 13;
  return 0;
};

const textCell = (ref, value, style = 0) => `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
const numberCell = (ref, value, style = 0) => `<c r="${ref}" s="${style}"><v>${Number.isFinite(Number(value)) ? Number(value) : 0}</v></c>`;

function renderCell(ref, cell) {
  const item = typeof cell === 'object' && cell !== null ? cell : { value: cell };
  const kind = item.kind || (typeof item.value === 'number' ? 'number' : 'text');
  const style = item.style ?? stylesFor(kind, item.tone);
  if (kind === 'date') return numberCell(ref, excelSerial(item.value), style);
  if (kind === 'number' || kind === 'currency') return numberCell(ref, item.value, style);
  return textCell(ref, item.value, style);
}

function worksheetXml(sheet, index) {
  const rows = sheet.rows || [];
  const columnWidths = sheet.columnWidths || [];
  const maxColumns = Math.max(1, ...rows.map((row) => row.length));
  const lastCell = `${columnName(maxColumns - 1)}${Math.max(1, rows.length)}`;
  const cols = Array.from({ length: maxColumns }, (_, column) => `<col min="${column + 1}" max="${column + 1}" width="${columnWidths[column] || 18}" customWidth="1"/>`).join('');
  const sheetRows = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => renderCell(`${columnName(columnIndex)}${rowIndex + 1}`, cell)).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCell}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="19"/>
  <cols>${cols}</cols>
  <sheetData>${sheetRows}</sheetData>
</worksheet>`;
}

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00\ &quot;€&quot;"/></numFmts>
  <fonts count="3"><font><sz val="10"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="10"/><name val="Arial"/><family val="2"/></font><font><b/><color rgb="FF9A671F"/><sz val="10"/><name val="Arial"/><family val="2"/></font></fonts>
  <fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE9F1EB"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF1D9"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF0F8F1"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF1EE"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD9E1DB"/></left><right style="thin"><color rgb="FFD9E1DB"/></right><top style="thin"><color rgb="FFD9E1DB"/></top><bottom style="thin"><color rgb="FFD9E1DB"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="14">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFill="1" applyFont="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="0" applyFill="1" applyFont="1"/>
    <xf numFmtId="165" fontId="2" fillId="3" borderId="0" applyFill="1" applyFont="1" applyNumberFormat="1"/>
    <xf numFmtId="164" fontId="2" fillId="3" borderId="0" applyFill="1" applyFont="1" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="1" fillId="4" borderId="0" applyFill="1" applyFont="1"/>
    <xf numFmtId="165" fontId="1" fillId="4" borderId="0" applyFill="1" applyFont="1" applyNumberFormat="1"/>
    <xf numFmtId="164" fontId="1" fillId="4" borderId="0" applyFill="1" applyFont="1" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="0" applyFill="1"/>
    <xf numFmtId="165" fontId="0" fillId="5" borderId="0" applyFill="1" applyNumberFormat="1"/>
    <xf numFmtId="164" fontId="0" fillId="5" borderId="0" applyFill="1" applyNumberFormat="1"/>
    <xf numFmtId="165" fontId="1" fillId="2" borderId="1" applyFill="1" applyFont="1" applyNumberFormat="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${Array.from({ length: 8 }, (_, index) => `  <Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`;

const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="1"/>
  <workbookPr defaultThemeVersion="124226"/>
  <bookViews><workbookView xWindow="0" yWindow="0" windowWidth="18000" windowHeight="12000"/></bookViews>
  <sheets>
    <sheet name="Riepilogo" sheetId="1" r:id="rId1"/>
    <sheet name="Movimenti" sheetId="2" r:id="rId2"/>
    <sheet name="Budget e permessi" sheetId="3" r:id="rId3"/>
    <sheet name="Categorie" sheetId="4" r:id="rId4"/>
    <sheet name="Utenti" sheetId="5" r:id="rId5"/>
    <sheet name="Ricorrenze" sheetId="6" r:id="rId6"/>
    <sheet name="Metodi e conti" sheetId="7" r:id="rId7"/>
    <sheet name="Configurazione" sheetId="8" r:id="rId8"/>
  </sheets>
</workbook>`;

const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet5.xml"/>
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet6.xml"/>
  <Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet7.xml"/>
  <Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet8.xml"/>
  <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const corePropsXml = (generatedAt) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>MyBudget — Backup dati</dc:title><dc:creator>MyBudget</dc:creator><cp:lastModifiedBy>MyBudget</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${generatedAt}</dcterms:created></cp:coreProperties>`;
const appPropsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>MyBudget</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>8</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="8" baseType="lpstr"><vt:lpstr>Riepilogo</vt:lpstr><vt:lpstr>Movimenti</vt:lpstr><vt:lpstr>Budget e permessi</vt:lpstr><vt:lpstr>Categorie</vt:lpstr><vt:lpstr>Utenti</vt:lpstr><vt:lpstr>Ricorrenze</vt:lpstr><vt:lpstr>Metodi e conti</vt:lpstr><vt:lpstr>Configurazione</vt:lpstr></vt:vector></TitlesOfParts></Properties>`;

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const uint16 = (value) => new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
const uint32 = (value) => new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
const joinBytes = (chunks) => {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => { output.set(chunk, offset); offset += chunk.length; });
  return output;
};

function zipStore(files) {
  const encoder = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;
  files.forEach(({ name, content }) => {
    const nameBytes = encoder.encode(name);
    const data = typeof content === 'string' ? encoder.encode(content) : content;
    const checksum = crc32(data);
    const header = joinBytes([
      uint32(0x04034b50), uint16(20), uint16(0x800), uint16(0), uint16(0), uint16(0), uint32(checksum), uint32(data.length), uint32(data.length), uint16(nameBytes.length), uint16(0), nameBytes,
    ]);
    locals.push(header, data);
    const directory = joinBytes([
      uint32(0x02014b50), uint16(20), uint16(20), uint16(0x800), uint16(0), uint16(0), uint16(0), uint32(checksum), uint32(data.length), uint32(data.length), uint16(nameBytes.length), uint16(0), uint16(0), uint16(0), uint16(0), uint32(0), uint32(offset), nameBytes,
    ]);
    central.push(directory);
    offset += header.length + data.length;
  });
  const centralBytes = joinBytes(central);
  const end = joinBytes([uint32(0x06054b50), uint16(0), uint16(0), uint16(files.length), uint16(files.length), uint32(centralBytes.length), uint32(offset), uint16(0)]);
  return joinBytes([...locals, centralBytes, end]);
}

const text = (value, tone = '') => ({ value: value ?? '', tone });
const money = (value, tone = '') => ({ value: Number(value) || 0, kind: 'currency', tone });
const dateCell = (value, tone = '') => ({ value: value || '', kind: 'date', tone });
const number = (value) => ({ value: Number(value) || 0, kind: 'number' });

function makeSheet(headers, rows, columnWidths, title) {
  return { columnWidths, rows: [[text(title), ...Array(Math.max(0, headers.length - 1)).fill(text(''))], headers.map((header) => ({ value: header, style: 1 })), ...rows] };
}

function buildSheets(state) {
  const getCategory = (id) => state.categories.find((category) => category.id === id);
  const getBudget = (id) => state.budgets.find((budget) => budget.id === id);
  const getUser = (id) => state.profiles.find((profile) => profile.id === id);
  const getPaymentMethod = (id) => state.paymentMethods?.find((method) => method.id === id);
  const isPlanned = (transaction) => transaction.type === 'entrata' && transaction.isReceived === false;
  const toneFor = (transaction) => isPlanned(transaction) ? 'planned' : transaction.type === 'entrata' ? 'income' : 'expense';
  const generatedAt = new Date().toISOString();

  const summaryRows = [];
  state.budgets.forEach((budget) => {
    for (let month = 1; month <= 12; month += 1) {
      const key = `2026-${String(month).padStart(2, '0')}`;
      const items = state.transactions.filter((transaction) => transaction.budgetId === budget.id && transaction.date.startsWith(key));
      const income = items.filter((transaction) => transaction.type === 'entrata' && !isPlanned(transaction)).reduce((sum, transaction) => sum + transaction.amount, 0);
      const planned = items.filter(isPlanned).reduce((sum, transaction) => sum + transaction.amount, 0);
      const expense = items.filter((transaction) => transaction.type === 'uscita').reduce((sum, transaction) => sum + transaction.amount, 0);
      summaryRows.push([text(budget.name), text(`${String(month).padStart(2, '0')}/2026`), money(income, 'income'), money(planned, 'planned'), money(expense, 'expense'), money(income - expense, income - expense >= 0 ? 'income' : 'expense')]);
    }
  });

  const movementRows = [...state.transactions].sort((a, b) => b.date.localeCompare(a.date)).map((transaction) => {
    const tone = toneFor(transaction);
    const category = getCategory(transaction.categoryId);
    const budget = getBudget(transaction.budgetId);
    const author = getUser(transaction.authorId);
    return [dateCell(transaction.date, tone), text(transaction.type === 'entrata' ? 'Entrata' : 'Uscita', tone), text(isPlanned(transaction) ? 'Prevista' : transaction.type === 'entrata' ? 'Incassata' : 'Pagata', tone), money(transaction.amount, tone), text(category?.name || 'Senza categoria', tone), text(getPaymentMethod(transaction.paymentMethodId)?.name || 'Non specificato', tone), text(budget?.name || 'Budget non disponibile', tone), text(transaction.description, tone), text(author ? `${author.firstName} ${author.lastName}` : 'Utente', tone), text(transaction.recurring ? 'Sì' : 'No', tone)];
  });

  const membershipRows = [];
  state.budgets.forEach((budget) => {
    state.budgetMembers.filter((member) => member.budgetId === budget.id).forEach((member) => {
      const user = getUser(member.userId);
      membershipRows.push([text(budget.name), text(user ? `${user.firstName} ${user.lastName}` : member.userId), text(member.view ? 'Sì' : 'No'), text(member.add ? 'Sì' : 'No'), text(member.edit ? 'Sì' : 'No'), text(member.manage ? 'Sì' : 'No')]);
    });
  });

  const categoryRows = state.categories.map((category) => {
    const owner = getUser(category.ownerId);
    const budgets = state.budgetCategories.filter((item) => item.categoryId === category.id && item.enabled).map((item) => getBudget(item.budgetId)?.name).filter(Boolean).join(', ');
    const limits = state.categoryLimits.filter((limit) => limit.categoryId === category.id).map((limit) => `${getBudget(limit.budgetId)?.name || ''}: ${Number(limit.monthlyLimit).toFixed(2)} €`).join(', ');
    return [text(category.name), text(category.type), text(category.default ? 'Sì' : 'No'), text(category.archived ? 'Sì' : 'No'), text(owner ? `${owner.firstName} ${owner.lastName}` : 'Sistema'), dateCell(category.createdAt?.slice(0, 10)), text(budgets || '—'), text(limits || '—')];
  });

  const userRows = state.profiles.map((profile) => [text(profile.firstName), text(profile.lastName), text(profile.email || 'Email non disponibile'), text(profile.role === 'admin' ? 'Amministratore' : 'Utente standard'), text(profile.status.replace('_', ' '))]);
  const recurringRows = state.recurringTransactions.map((recurring) => {
    const budget = getBudget(recurring.budgetId);
    const category = getCategory(recurring.categoryId);
    const author = getUser(recurring.authorId);
    return [text(recurring.description), money(recurring.amount, recurring.type === 'entrata' ? 'income' : 'expense'), text(recurring.type === 'entrata' ? (recurring.isReceived === false ? 'Entrata prevista' : 'Entrata incassata') : 'Uscita'), text(recurring.frequency), number(recurring.day), dateCell(recurring.nextDate), text(recurring.active ? 'Sì' : 'No'), text(budget?.name || '—'), text(category?.name || '—'), text(getPaymentMethod(recurring.paymentMethodId)?.name || 'Non specificato'), text(author ? `${author.firstName} ${author.lastName}` : '—')];
  });

  const configurationRows = [
    [text('Esportato il'), text(generatedAt)],
    [text('Budget selezionato'), text(getBudget(state.selectedBudgetId)?.name || '—')],
    [text('Pagina corrente'), text(state.currentPage || 'dashboard')],
    [text('Filtro mese'), text(state.transactionFilters?.month || 'all')],
    [text('Filtro tipo'), text(state.transactionFilters?.type || 'all')],
    [text('Filtro categoria'), text(getCategory(state.transactionFilters?.category)?.name || 'all')],
    [text('Filtro metodo/conto'), text(getPaymentMethod(state.transactionFilters?.paymentMethod)?.name || 'all')],
    [text('Filtro ricerca'), text(state.transactionFilters?.query || '')],
  ];

  const paymentMethodRows = (state.paymentMethods || []).map((method) => {
    const budget = getBudget(method.budgetId);
    const owner = getUser(method.ownerId);
    return [text(budget?.name || '—'), text(method.name), text(method.kind || 'altro'), money(method.initialBalance), dateCell(method.openingDate), text(method.default ? 'Sì' : 'No'), text(method.archived ? 'Sì' : 'No'), text(owner ? `${owner.firstName} ${owner.lastName}` : 'Sistema')];
  });

  return [
    { name: 'Riepilogo', sheet: makeSheet(['Budget', 'Mese', 'Entrate incassate', 'Entrate previste', 'Uscite', 'Saldo effettivo'], summaryRows, [24, 13, 18, 18, 14, 18], 'MyBudget — Riepilogo annuale 2026') },
    { name: 'Movimenti', sheet: makeSheet(['Data', 'Tipo', 'Stato', 'Importo', 'Categoria', 'Metodo/conto', 'Budget', 'Descrizione', 'Autore', 'Ricorrente'], movementRows, [13, 12, 14, 14, 22, 22, 24, 42, 22, 12], 'MyBudget — Backup movimenti') },
    { name: 'Budget e permessi', sheet: makeSheet(['Budget', 'Utente', 'Può vedere', 'Può aggiungere', 'Può modificare', 'Può gestire'], membershipRows, [26, 24, 14, 17, 17, 15], 'MyBudget — Budget e permessi') },
    { name: 'Categorie', sheet: makeSheet(['Categoria', 'Tipo', 'Predefinita', 'Archiviata', 'Creata da', 'Data creazione', 'Budget associati', 'Limiti mensili'], categoryRows, [24, 14, 13, 13, 24, 16, 34, 30], 'MyBudget — Categorie e configurazioni') },
    { name: 'Utenti', sheet: makeSheet(['Nome', 'Cognome', 'Email', 'Ruolo', 'Stato'], userRows, [18, 20, 34, 20, 15], 'MyBudget — Utenti') },
    { name: 'Ricorrenze', sheet: makeSheet(['Descrizione', 'Importo', 'Tipo e stato', 'Frequenza', 'Giorno', 'Prossima data', 'Attiva', 'Budget', 'Categoria', 'Metodo/conto', 'Autore'], recurringRows, [34, 14, 22, 14, 10, 16, 10, 24, 24, 22, 22], 'MyBudget — Movimenti ricorrenti') },
    { name: 'Metodi e conti', sheet: makeSheet(['Budget', 'Metodo/conto', 'Tipologia', 'Saldo iniziale', 'Data saldo iniziale', 'Predefinito', 'Archiviato', 'Creato da'], paymentMethodRows, [25, 26, 18, 18, 20, 14, 14, 24], 'MyBudget — Metodi e conti') },
    { name: 'Configurazione', sheet: makeSheet(['Parametro', 'Valore'], configurationRows, [24, 48], 'MyBudget — Configurazione export') },
  ];
}

export function downloadBudgetExport(state) {
  const generatedAt = new Date();
  const sheets = buildSheets(state);
  const files = [
    { name: '[Content_Types].xml', content: contentTypesXml },
    { name: '_rels/.rels', content: rootRelsXml },
    { name: 'docProps/core.xml', content: corePropsXml(generatedAt.toISOString()) },
    { name: 'docProps/app.xml', content: appPropsXml },
    { name: 'xl/workbook.xml', content: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', content: workbookRelsXml },
    { name: 'xl/styles.xml', content: stylesXml },
    ...sheets.map(({ sheet }, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, content: worksheetXml(sheet, index + 1) })),
  ];
  const bytes = zipStore(files);
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `MyBudget-backup-${generatedAt.toISOString().slice(0, 10)}.xlsx`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return anchor.download;
}
