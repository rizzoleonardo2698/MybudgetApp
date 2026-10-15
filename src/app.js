import { loadState, resetState, saveState } from './store.js';
import { isSupabaseConfigured, supabase } from './supabase.js';
import { downloadBudgetExport } from './export-xlsx.js';
import { isValidIsoDate, parseMovementWorkbook } from './import-xlsx.js';

const remoteMode = isSupabaseConfigured;
const ATTACHMENT_BUCKET = 'transaction-attachments';
const MAX_TRANSACTION_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
let state = remoteMode ? { ...loadState(), sessionUserId: null } : loadState();
let authUser = null;
let isLoading = remoteMode;
let attachmentsFeatureAvailable = false;
let hydrationPromise = null;
let importDraft = null;
let pendingMovementDraft = null;
let toastTimer;
const app = document.querySelector('#app');

state.archivedBudgets ||= [];
state.budgetAccess ||= {};
state.adminBudgetSummaries ||= [];
state.paymentMethods ||= [];
state.recurringExceptions ||= [];
state.paymentMethodBudgetId ||= state.selectedBudgetId;
state.paymentMethodMonth ||= state.dashboardMonth;
state.dashboardReportView ||= 'cashflow';
state.transactionFilters ||= { month: 'all', type: 'all', category: 'all', incomeStatus: 'all', paymentMethod: 'all', query: '' };
state.transactionFilters.paymentMethod ||= 'all';

const euro = (value) => new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(value);
const date = (value) => new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00`));
const monthLabel = (key) => new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' }).format(new Date(`${key}-01T12:00:00`));
const initials = (profile) => `${profile.firstName[0]}${profile.lastName[0]}`;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const withTimeout = (promise, milliseconds, message) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds))]);
const AUTH_SETTLE_DELAY = 450;
const getUser = (id = state.sessionUserId) => state.profiles.find((profile) => profile.id === id);
const getBudget = (id = state.selectedBudgetId) => state.budgets.find((budget) => budget.id === id);
const getAnyBudget = (id) => getBudget(id) || state.archivedBudgets.find((budget) => budget.id === id) || (() => { const item = state.adminBudgetSummaries.find((summary) => summary.budgetId === id); return item ? { id: item.budgetId, name: item.budgetName, color: item.budgetColor, createdBy: item.budgetCreatedBy, archivedAt: item.archivedAt } : null; })();
const getCategory = (id) => state.categories.find((category) => category.id === id);
const getPaymentMethod = (id) => state.paymentMethods.find((method) => method.id === id);
const paymentMethodKindLabels = { contanti: 'Contanti', carta: 'Carta', conto_bancario: 'Conto bancario', paypal: 'PayPal', conto_comune: 'Conto comune', altro: 'Altro', non_specificato: 'Non specificato' };
const paymentMethodKindLabel = (kind) => paymentMethodKindLabels[kind] || 'Altro';
const paymentMethodsForBudget = (budgetId, includeArchived = false) => state.paymentMethods.filter((method) => method.budgetId === budgetId && (includeArchived || !method.archived));
const defaultPaymentMethodForBudget = (budgetId) => paymentMethodsForBudget(budgetId).find((method) => method.default) || paymentMethodsForBudget(budgetId).find((method) => method.name.toLowerCase() === 'non specificato');
const transactionPaymentMethodId = (transaction) => transaction?.paymentMethodId || defaultPaymentMethodForBudget(transaction?.budgetId)?.id || '';
const canManagePaymentMethod = (method) => Boolean(method && !method.default && method.ownerId === state.sessionUserId && can('add', method.budgetId));
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
const persist = () => { if (!remoteMode) saveState(state); };
const authRedirectUrl = () => {
  const configured = import.meta.env.NEXT_PUBLIC_AUTH_REDIRECT_URL || import.meta.env.VITE_AUTH_REDIRECT_URL;
  return configured || window.location.origin;
};
const iconFor = (name = '') => ({ casa: '⌂', 'casa al mare': '⌂', anzio: '⌂', supermercati: '▦', 'spesa alimentare': '▦', trasporti: '↗', salute: '✚', intrattenimento: '✦', 'tempo libero': '✦', 'cene fuori': '◌', amazon: '↘', stipendio: '↑', 'barca entrate': '↗', rifornimenti: '▣', condominio: '⌂', manutenzione: '⚒', pulizia: '✧' }[name.toLowerCase()] || '•');
const isPlannedIncome = (transaction) => transaction.type === 'entrata' && (transaction.isReceived === false || isProjectedTransaction(transaction));
const isEffectiveIncome = (transaction) => transaction.type === 'entrata' && !isPlannedIncome(transaction);
const isProjectedTransaction = (transaction) => transaction.isProjected === true;
const isPlannedTransaction = (transaction) => isProjectedTransaction(transaction) || isPlannedIncome(transaction);
const isEffectiveExpense = (transaction) => transaction.type === 'uscita' && !isProjectedTransaction(transaction);
const formatLocalDate = (value = new Date()) => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
const formatLongLocalDate = (value) => {
  const label = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${value}T12:00:00`));
  return label.charAt(0).toUpperCase() + label.slice(1);
};
const APP_YEAR = 2026;
const APP_TODAY = formatLocalDate();
const CURRENT_MONTH_KEY = APP_TODAY.slice(0, 7);
const DEFAULT_DASHBOARD_MONTH = CURRENT_MONTH_KEY.startsWith(`${APP_YEAR}-`) ? CURRENT_MONTH_KEY : `${APP_YEAR}-01`;
const YEAR_START = `${APP_YEAR}-01-01`;
const YEAR_END = `${APP_YEAR}-12-31`;
if (!state.dashboardMonth || state.dashboardMonth === '2026-09') state.dashboardMonth = DEFAULT_DASHBOARD_MONTH;
if (!state.categoryMonth || !/^\d{4}-\d{2}$/.test(state.categoryMonth)) state.categoryMonth = DEFAULT_DASHBOARD_MONTH;
if (!['month', 'year'].includes(state.categoryView)) state.categoryView = 'month';
const addMonths = (value, amount) => {
  const base = new Date(`${value}T12:00:00`);
  if (Number.isNaN(base.getTime())) return value;
  const target = new Date(base);
  target.setDate(1);
  target.setMonth(target.getMonth() + amount);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(base.getDate(), lastDay));
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
};
const maxRecurringEndDate = (startDate) => addMonths(startDate, 12);
const recurringDate = (value, frequency, day) => {
  const base = new Date(`${value}T12:00:00`);
  if (Number.isNaN(base.getTime())) return value;
  const target = new Date(base);
  if (frequency === 'annuale') target.setFullYear(target.getFullYear() + 1, target.getMonth(), 1);
  else target.setMonth(target.getMonth() + 1, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(Math.max(Number(day) || base.getDate(), 1), lastDay));
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
};
const selectedRecurring = (transaction) => state.recurringTransactions.find((item) => item.id === transaction?.recurringTransactionId);
const can = (permission, budgetId = state.selectedBudgetId) => {
  const user = getUser();
  return Boolean(user && state.budgetMembers.some((member) => member.budgetId === budgetId && member.userId === user.id && member[permission]));
};
const canDeleteTransaction = (transaction) => Boolean(
  transaction
  && !transaction.isProjected
  && transaction.authorId === state.sessionUserId
  && can('add', transaction.budgetId),
);
const canManageProjectedOccurrence = (transaction) => Boolean(transaction?.isProjected && can('add', transaction.budgetId));

const isBudgetOwner = (budget) => Boolean(budget && (budget.createdBy === state.sessionUserId || (!remoteMode && state.budgetMembers.some((member) => member.budgetId === budget.id && member.userId === state.sessionUserId && member.manage))));
const budgetTransactionsCount = (budgetId) => state.transactions.filter((transaction) => transaction.budgetId === budgetId).length;
const budgetRecurringCount = (budgetId) => state.recurringTransactions.filter((transaction) => transaction.budgetId === budgetId).length;
const budgetCategoryCount = (budgetId) => state.budgetCategories.filter((item) => item.budgetId === budgetId && item.enabled).length;
const budgetAccessFor = (budgetId) => state.budgetAccess?.[budgetId] || state.budgetMembers.filter((member) => member.budgetId === budgetId).map((member) => ({
  userId: member.userId,
  firstName: getUser(member.userId)?.firstName || 'Utente',
  lastName: getUser(member.userId)?.lastName || '',
  email: getUser(member.userId)?.email || 'Email non disponibile',
  canView: member.view,
  canAdd: member.add,
  canEdit: member.edit,
}));

function recurringOccurrences() {
  const projected = [];
  state.recurringTransactions.filter((item) => item.active).forEach((item) => {
    const linkedDates = state.transactions.filter((transaction) => transaction.recurringTransactionId === item.id).map((transaction) => transaction.date).sort();
    const startDate = item.startDate || linkedDates[0] || item.nextDate || APP_TODAY;
    const endDate = item.endDate || maxRecurringEndDate(startDate);
    let occurrence = startDate;
    let guard = 0;
    while (occurrence <= YEAR_END && occurrence <= endDate && guard < 120) {
      const isExcluded = state.recurringExceptions.some((exception) => exception.recurringTransactionId === item.id && exception.date === occurrence);
      if (occurrence >= APP_TODAY && occurrence >= YEAR_START && !isExcluded && !state.transactions.some((transaction) => transaction.recurringTransactionId === item.id && transaction.date === occurrence)) {
        projected.push({
          id: `projected-${item.id}-${occurrence}`,
          date: occurrence,
          amount: Number(item.amount),
          type: item.type,
          categoryId: item.categoryId,
          paymentMethodId: item.paymentMethodId || null,
          description: item.description,
          budgetId: item.budgetId,
          authorId: item.authorId,
          isReceived: item.type === 'entrata' ? item.isReceived !== false : true,
          recurringTransactionId: item.id,
          recurring: true,
          isProjected: true,
        });
      }
      const next = recurringDate(occurrence, item.frequency, item.day);
      if (!next || next <= occurrence) break;
      occurrence = next;
      guard += 1;
    }
  });
  return projected;
}

const transactionsForBudget = (budgetId) => [
  ...state.transactions.filter((transaction) => transaction.budgetId === budgetId),
  ...recurringOccurrences().filter((transaction) => transaction.budgetId === budgetId),
];
const findTransactionById = (transactionId) => state.transactions.find((transaction) => transaction.id === transactionId) || recurringOccurrences().find((transaction) => transaction.id === transactionId);

function refreshSummary() {
  state.monthlySummary = Array.from({ length: 12 }, (_, index) => {
    const key = `${APP_YEAR}-${String(index + 1).padStart(2, '0')}`;
    const items = transactionsForBudget(state.selectedBudgetId).filter((tx) => tx.date.startsWith(key));
    return { key, label: new Intl.DateTimeFormat('it-IT', { month: 'short' }).format(new Date(`${key}-01T12:00:00`)).replace('.', ''), income: items.filter(isEffectiveIncome).reduce((sum, tx) => sum + tx.amount, 0), plannedIncome: items.filter(isPlannedIncome).reduce((sum, tx) => sum + tx.amount, 0), expense: items.filter(isEffectiveExpense).reduce((sum, tx) => sum + tx.amount, 0), plannedExpense: items.filter((tx) => tx.type === 'uscita' && isProjectedTransaction(tx)).reduce((sum, tx) => sum + tx.amount, 0) };
  });
}

const dashboardMonths = () => state.monthlySummary;

function renderDashboardChart(view, max) {
  if (view === 'annual') {
    const annual = state.monthlySummary.reduce((totals, item) => ({ income: totals.income + item.income, expense: totals.expense + item.expense, planned: totals.planned + (item.plannedIncome || 0) }), { income: 0, expense: 0, planned: 0 });
    let cumulative = 0;
    const months = state.monthlySummary.map((item) => {
      cumulative += item.income - item.expense;
      return { ...item, cumulative };
    });
    const cumulativeMax = Math.max(1, ...months.map((item) => Math.abs(item.cumulative)));
    return `<div class="annual-kpis"><button class="annual-kpi dashboard-link" data-action="dashboard-filter" data-period="all" data-type="entrata" data-income-status="effective" aria-label="Apri le entrate effettive del 2026"><span>Entrate effettive</span><strong class="positive">${euro(annual.income)}</strong></button><button class="annual-kpi dashboard-link" data-action="dashboard-filter" data-period="all" data-type="uscita" aria-label="Apri le uscite del 2026"><span>Uscite</span><strong class="negative">${euro(annual.expense)}</strong></button><button class="annual-kpi annual-kpi-highlight dashboard-link" data-action="dashboard-filter" data-period="all" data-type="all" aria-label="Apri tutti i movimenti del 2026"><span>Disponibilità annua</span><strong class="${annual.income - annual.expense >= 0 ? 'positive' : 'negative'}">${euro(annual.income - annual.expense)}</strong></button></div><div class="legend"><span><i class="legend-dot income-dot"></i> Disponibilità cumulata</span><span class="legend-hint">Le entrate previste (${euro(annual.planned)}) restano escluse</span></div><div class="annual-chart" aria-label="Disponibilità cumulata mese per mese"><div class="annual-chart-caption"><span>Come cambia durante l’anno</span><strong>${euro(annual.income - annual.expense)} a fine anno</strong></div><div class="annual-bars">${months.map((item) => `<button class="annual-month ${item.cumulative >= 0 ? 'positive-month' : 'negative-month'}" data-action="dashboard-filter" data-period="${item.key}" data-type="all" aria-label="Apri ${monthLabel(item.key)}: disponibilità ${euro(item.cumulative)}"><span class="annual-bar" style="height:${Math.max(8, Math.abs(item.cumulative) / cumulativeMax * 118)}px"></span><small>${item.label}</small><em>${Math.round(item.cumulative)}€</em></button>`).join('')}</div></div>`;
  }
  return `<div class="legend"><span><i class="legend-dot income-dot"></i> Entrate incassate</span><span><i class="legend-dot expense-dot"></i> Uscite</span><span class="legend-hint">Le previste non alterano il saldo</span></div><div class="chart" aria-label="Grafico entrate e uscite mensili">${state.monthlySummary.map((item) => { const positive = item.income >= item.expense; return `<button class="chart-column" data-action="dashboard-filter" data-period="${item.key}" data-type="all" aria-label="Apri ${monthLabel(item.key)}"><div class="bar-pair"><span class="bar income-bar" style="height:${Math.max(8, item.income / max * 120)}px"></span><span class="bar expense-bar" style="height:${Math.max(8, item.expense / max * 120)}px"></span></div><span class="month-tag ${positive ? 'positive-month' : 'negative-month'}">${item.label}</span><small>${positive ? '+' : ''}${Math.round(item.income - item.expense)}€</small></button>`; }).join('')}</div>`;
}

function renderDashboardReport(view, budget, periodTransactions, periodLabel, dashboardPeriod, max) {
  if (view === 'categories') {
    const totals = state.categories.map((category) => {
      const transactions = periodTransactions.filter((transaction) => transaction.categoryId === category.id);
      return {
        ...category,
        income: transactions.filter(isEffectiveIncome).reduce((sum, transaction) => sum + transaction.amount, 0),
        expense: transactions.filter(isEffectiveExpense).reduce((sum, transaction) => sum + transaction.amount, 0),
        plannedIncome: transactions.filter(isPlannedIncome).reduce((sum, transaction) => sum + transaction.amount, 0),
      };
    }).filter((category) => category.income > 0 || category.expense > 0 || category.plannedIncome > 0).sort((a, b) => (b.expense + b.income) - (a.expense + a.income));
    const maxTotal = Math.max(1, ...totals.map((category) => Math.max(category.income, category.expense)));
    return `<div class="dashboard-report-intro"><span>Entrate e uscite per categoria</span><strong>${periodLabel}</strong></div><div class="dashboard-report-list">${totals.length ? totals.map((category, index) => `<button class="dashboard-report-row" data-action="dashboard-filter" data-period="${dashboardPeriod}" data-type="all" data-category="${category.id}"><span class="category-icon icon-${index % 4}">${category.icon}</span><span class="dashboard-report-main"><strong>${escapeHtml(category.name)}</strong><small>${category.income ? `Entrate ${euro(category.income)}` : 'Nessuna entrata'}${category.plannedIncome ? ` · ${euro(category.plannedIncome)} previste` : ''}</small><i class="dashboard-report-meter"><b class="report-income-meter" style="width:${Math.max(2, category.income / maxTotal * 100)}%"></b><b class="report-expense-meter" style="width:${Math.max(2, category.expense / maxTotal * 100)}%"></b></i></span><strong class="dashboard-report-value negative">${euro(category.expense)}</strong></button>`).join('') : '<div class="empty-state"><span>◇</span><strong>Nessun movimento nel periodo</strong><p>Le categorie appariranno quando registrerai un’entrata o un’uscita.</p></div>'}</div><div class="legend dashboard-report-legend"><span><i class="legend-dot income-dot"></i> Entrate</span><span><i class="legend-dot expense-dot"></i> Uscite</span><span class="legend-hint">Clicca una riga per filtrare i movimenti</span></div>`;
  }
  if (view === 'methods') {
    const methods = paymentMethodsForBudget(budget.id);
    const allBudgetTransactions = transactionsForBudget(budget.id);
    return `<div class="dashboard-report-intro"><span>Disponibilità per metodo o conto</span><strong>${periodLabel}</strong></div><div class="dashboard-report-list">${methods.length ? methods.map((method, index) => {
      const transactions = periodTransactions.filter((transaction) => transactionPaymentMethodId(transaction) === method.id);
      const income = transactions.filter(isEffectiveIncome).reduce((sum, transaction) => sum + transaction.amount, 0);
      const expense = transactions.filter(isEffectiveExpense).reduce((sum, transaction) => sum + transaction.amount, 0);
      const plannedIncome = transactions.filter(isPlannedIncome).reduce((sum, transaction) => sum + transaction.amount, 0);
      const openingDate = method.openingDate || YEAR_START;
      const currentMovements = allBudgetTransactions.filter((transaction) => !transaction.isProjected && transactionPaymentMethodId(transaction) === method.id && transaction.date >= openingDate);
      const currentBalance = method.initialBalance + currentMovements.filter(isEffectiveIncome).reduce((sum, transaction) => sum + transaction.amount, 0) - currentMovements.filter(isEffectiveExpense).reduce((sum, transaction) => sum + transaction.amount, 0);
      return `<button class="dashboard-report-row" data-action="dashboard-filter" data-period="${dashboardPeriod}" data-type="all" data-payment-method="${method.id}"><span class="payment-method-icon payment-method-icon-${index % 4}">${method.default ? '•' : method.kind === 'contanti' ? '€' : method.kind === 'paypal' ? 'P' : '▣'}</span><span class="dashboard-report-main"><strong>${escapeHtml(method.name)}</strong><small>${paymentMethodKindLabel(method.kind)} · Periodo: ${income ? `+${euro(income)}` : '+0,00 €'} / ${expense ? `−${euro(expense)}` : '−0,00 €'}${plannedIncome ? ` · ${euro(plannedIncome)} previste` : ''}</small><i class="dashboard-report-meter"><b class="report-income-meter" style="width:${Math.max(2, Math.min(100, income / Math.max(1, max) * 100))}%"></b><b class="report-expense-meter" style="width:${Math.max(2, Math.min(100, expense / Math.max(1, max) * 100))}%"></b></i></span><strong class="dashboard-report-value ${currentBalance >= 0 ? 'positive' : 'negative'}">${euro(currentBalance)}</strong></button>`;
    }).join('') : '<div class="empty-state"><span>◈</span><strong>Nessun metodo configurato</strong><p>Apri “I miei metodi e conti” per aggiungerne uno.</p></div>'}</div><div class="legend dashboard-report-legend"><span><i class="legend-dot income-dot"></i> Entrate del periodo</span><span><i class="legend-dot expense-dot"></i> Uscite del periodo</span><span class="legend-hint">Il saldo include l’apertura e i movimenti effettivi</span></div>`;
  }
  return renderDashboardChart(state.dashboardChartView === 'annual' ? 'annual' : 'monthly', max);
}

async function loadRemoteState(user, attempt = 0) {
  const results = await Promise.all([
    supabase.from('profiles').select('*'),
    supabase.from('budgets').select('*'),
    supabase.from('budget_members').select('*'),
    supabase.from('categories').select('*'),
    supabase.from('budget_categories').select('*').eq('enabled', true),
    supabase.from('transactions').select('*').is('archived_at', null).order('transaction_date', { ascending: false }),
    supabase.from('recurring_transactions').select('*'),
    supabase.from('recurring_transaction_exceptions').select('*'),
    supabase.from('category_limits').select('*'),
    supabase.from('payment_methods').select('*').order('is_archived').order('name'),
  ]);
  const failed = results.find((result) => result.error);
  if (failed && attempt === 0) {
    await wait(700);
    return loadRemoteState(user, attempt + 1);
  }
  if (failed) throw failed.error;
  const [profiles, budgets, members, categories, budgetCategories, transactions, recurring, recurringExceptions, limits, paymentMethods] = results.map((result) => result.data || []);
  const attachmentResult = await supabase.from('transaction_attachments').select('*').order('created_at');
  if (attachmentResult.error) {
    if (['42P01', 'PGRST205'].includes(attachmentResult.error.code)) {
      attachmentsFeatureAvailable = false;
    } else {
      throw attachmentResult.error;
    }
  } else {
    attachmentsFeatureAvailable = true;
  }
  const attachments = attachmentResult.data || [];
  state.profiles = profiles.map((p) => ({ id: p.id, firstName: p.first_name, lastName: p.last_name, email: p.email || (p.id === user.id ? user.email : 'Email non disponibile'), role: p.role, status: p.status }));
  const mappedBudgets = budgets.map((b) => ({ id: b.id, name: b.name, color: b.color, createdBy: b.created_by, archivedAt: b.archived_at || null, createdAt: b.created_at }));
  state.budgets = mappedBudgets.filter((budget) => !budget.archivedAt);
  state.archivedBudgets = mappedBudgets.filter((budget) => budget.archivedAt);
  state.budgetMembers = members.map((m) => ({ budgetId: m.budget_id, userId: m.user_id, view: m.can_view, add: m.can_add, edit: m.can_edit, manage: m.can_manage }));
  state.categories = categories.map((c) => ({ id: c.id, name: c.name, type: c.type, default: c.is_default, archived: c.is_archived, allowAttachments: Boolean(c.allow_attachments), ownerId: c.owner_id, createdAt: c.created_at, icon: iconFor(c.name) }));
  state.budgetCategories = budgetCategories.map((x) => ({ budgetId: x.budget_id, categoryId: x.category_id, enabled: x.enabled }));
  state.transactions = transactions.map((t) => ({ id: t.id, date: t.transaction_date, amount: Number(t.amount), type: t.type, categoryId: t.category_id, paymentMethodId: t.payment_method_id || null, description: t.description, budgetId: t.budget_id, authorId: t.author_id, isReceived: t.type !== 'entrata' || t.is_received !== false, recurringTransactionId: t.recurring_transaction_id || null, recurring: Boolean(t.recurring_transaction_id), isProjected: false }));
  state.attachments = attachments.map((a) => ({ id: a.id, transactionId: a.transaction_id, budgetId: a.budget_id, path: a.object_path, name: a.file_name, contentType: a.content_type, size: Number(a.byte_size), uploadedBy: a.uploaded_by, createdAt: a.created_at }));
  state.recurringTransactions = recurring.map((r) => ({ id: r.id, description: r.description, amount: Number(r.amount), type: r.type, frequency: r.frequency, day: r.day_of_period, startDate: r.start_date, endDate: r.end_date || maxRecurringEndDate(r.start_date), nextDate: r.next_insert_date, active: r.active, budgetId: r.budget_id, categoryId: r.category_id, paymentMethodId: r.payment_method_id || null, authorId: r.author_id, isReceived: r.type !== 'entrata' || r.is_received !== false }));
  state.recurringExceptions = recurringExceptions.map((item) => ({ id: item.id, recurringTransactionId: item.recurring_transaction_id, date: item.occurrence_date, createdBy: item.created_by }));
  state.paymentMethods = paymentMethods.map((pm) => ({ id: pm.id, budgetId: pm.budget_id, ownerId: pm.owner_id, name: pm.name, kind: pm.kind, initialBalance: Number(pm.opening_balance || 0), openingDate: pm.opening_balance_date, default: pm.is_default, archived: pm.is_archived, createdAt: pm.created_at }));
  state.categoryLimits = limits.map((l) => ({ categoryId: l.category_id, budgetId: l.budget_id, monthlyLimit: Number(l.monthly_limit), used: state.transactions.filter((t) => t.categoryId === l.category_id && t.budgetId === l.budget_id && t.type === 'uscita' && t.date.startsWith(CURRENT_MONTH_KEY)).reduce((sum, t) => sum + t.amount, 0) }));
  state.sessionUserId = user.id;
  if (!state.selectedBudgetId || !state.budgets.some((b) => b.id === state.selectedBudgetId)) state.selectedBudgetId = state.budgets[0]?.id;
  if (!state.paymentMethodBudgetId || !state.budgets.some((b) => b.id === state.paymentMethodBudgetId)) state.paymentMethodBudgetId = state.selectedBudgetId;
  const profile = state.profiles.find((item) => item.id === user.id);
  if (profile?.role === 'admin') {
    const { data: summaries, error: summaryError } = await supabase.rpc('admin_list_user_budget_summaries');
    state.adminBudgetSummaries = summaryError ? [] : (summaries || []).map((item) => ({
      userId: item.user_id,
      firstName: item.first_name,
      lastName: item.last_name,
      email: item.email,
      status: item.status,
      budgetId: item.budget_id,
      budgetName: item.budget_name,
      budgetColor: item.budget_color,
      budgetCreatedBy: item.budget_created_by,
      archivedAt: item.archived_at,
      memberCount: Number(item.member_count || 0),
      transactionCount: Number(item.transaction_count || 0),
      recurringCount: Number(item.recurring_count || 0),
    }));
  } else state.adminBudgetSummaries = [];
  refreshSummary();
}

async function syncAdminProfiles() {
  if (!remoteMode || getUser()?.role !== 'admin') return { synced: 0 };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData.session?.access_token) throw new Error('Sessione amministratore non disponibile. Accedi di nuovo.');
  const response = await fetch('/api/admin/sync-users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionData.session.access_token}` },
  });
  let result = {};
  try { result = await response.json(); } catch { /* risposta non JSON */ }
  if (!response.ok) throw new Error(result.error || 'Impossibile sincronizzare le richieste di registrazione.');
  return result;
}

function hydrateSession(session) {
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    authUser = session?.user || null;
    if (!authUser) {
      state.sessionUserId = null;
      isLoading = false;
      render();
      return;
    }
    isLoading = true;
    render();
    try {
      await loadRemoteState(authUser);
      let profile = getUser();
      if (profile?.role === 'admin') {
        try {
          const syncResult = await syncAdminProfiles();
          if (Number(syncResult.synced) > 0) await loadRemoteState(authUser);
          profile = getUser();
        } catch (syncError) {
          console.warn('[MyBudget] sincronizzazione profili amministratore non riuscita:', syncError);
        }
      }
      if (!profile || profile.status !== 'attivo') {
        await supabase.auth.signOut();
        showToast('Il profilo è in attesa di approvazione.', 'info');
      }
    } catch (error) {
      state.sessionUserId = null;
      showToast(`Impossibile caricare i dati: ${error.message}`, 'error');
    } finally {
      isLoading = false;
      render();
    }
  })().finally(() => { hydrationPromise = null; });
  return hydrationPromise;
}

async function init() {
  if (!remoteMode) { refreshSummary(); isLoading = false; render(); return; }
  try {
    const { data, error } = await withTimeout(supabase.auth.getSession(), 10000, 'Supabase non ha risposto in tempo. Riprova tra qualche secondo.');
    if (error) showToast(`Errore sessione: ${error.message}`, 'error');
    await withTimeout(hydrateSession(data?.session), 15000, 'Il caricamento dei dati sta richiedendo troppo tempo.');
    supabase.auth.onAuthStateChange((_event, session) => setTimeout(() => hydrateSession(session), AUTH_SETTLE_DELAY));
  } catch (error) {
    state.sessionUserId = null;
    isLoading = false;
    render();
    showToast(error.message, 'error');
  }
}

function setPage(page) {
  state.currentPage = page;
  state.transactionFilters = page === 'transactions' ? state.transactionFilters : { month: 'all', type: 'all', category: 'all', incomeStatus: 'all', paymentMethod: 'all', query: '' };
  persist();
  render();
}

function openTransactions(filters = {}) {
  state.transactionFilters = { month: 'all', type: 'all', category: 'all', incomeStatus: 'all', paymentMethod: 'all', query: '', ...filters };
  setPage('transactions');
}

function showToast(message, tone = 'success') {
  clearTimeout(toastTimer);
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.append(toast);
  }
  toast.dataset.tone = tone;
  toast.textContent = message;
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2800);
}

async function compressAttachmentImage(file) {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name}: scegli un’immagine.`);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name}: questo formato immagine non può essere compresso dal browser.`);
  }
  const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.78));
  if (!blob) throw new Error(`${file.name}: non è stato possibile comprimere l’immagine.`);
  if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name}: l’immagine compressa supera 8 MB.`);
  return { blob, name: `${file.name.replace(/\.[^.]+$/, '') || 'foto'}.jpg` };
}

async function uploadTransactionAttachments(transaction, files) {
  const failures = [];
  for (const file of files) {
    let path = null;
    try {
      const { blob, name } = await compressAttachmentImage(file);
      path = `${transaction.budgetId}/${transaction.id}/${crypto.randomUUID()}.jpg`;
      const { error: uploadError } = await supabase.storage.from(ATTACHMENT_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (uploadError) throw uploadError;
      const { error: rowError } = await supabase.from('transaction_attachments').insert({
        transaction_id: transaction.id,
        budget_id: transaction.budgetId,
        object_path: path,
        file_name: name,
        content_type: 'image/jpeg',
        byte_size: blob.size,
        uploaded_by: state.sessionUserId,
      });
      if (rowError) {
        await supabase.storage.from(ATTACHMENT_BUCKET).remove([path]);
        throw rowError;
      }
    } catch (error) {
      failures.push(error.message || 'Errore durante il caricamento dell’immagine.');
    }
  }
  return failures;
}

async function openTransactionAttachments(transactionId) {
  const transaction = state.transactions.find((item) => item.id === transactionId);
  if (!remoteMode || !transaction) return;
  const attachments = state.attachments.filter((item) => item.transactionId === transactionId);
  if (!attachments.length) return showToast('Questo movimento non ha allegati.', 'info');
  const title = escapeHtml(transaction.description);
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal attachment-viewer" role="dialog" aria-modal="true" aria-label="Allegati del movimento" data-stop-propagation><div class="modal-header"><div><span class="section-kicker">${date(transaction.date)} · ${euro(transaction.amount)}</span><h2>${title}</h2></div><button class="icon-button" data-action="close-modal" aria-label="Chiudi">×</button></div><div class="attachment-gallery"><div class="empty-state"><span>◌</span><strong>Caricamento immagini…</strong></div></div></section></div>`;
  const gallery = document.querySelector('.attachment-gallery');
  const images = await Promise.all(attachments.map(async (attachment) => {
    const { data, error } = await supabase.storage.from(ATTACHMENT_BUCKET).download(attachment.path);
    if (error) return `<div class="attachment-error">${escapeHtml(attachment.name)} · Impossibile aprire il file</div>`;
    const url = URL.createObjectURL(data);
    return `<figure class="attachment-preview"><img src="${url}" alt="${escapeHtml(attachment.name)}" /><figcaption>${escapeHtml(attachment.name)}</figcaption></figure>`;
  }));
  if (gallery?.isConnected) gallery.innerHTML = images.join('');
}

function render() {
  if (isLoading) {
    app.innerHTML = '<main class="auth-page"><section class="auth-card-wrap"><div class="auth-card"><div class="auth-card-heading"><span class="eyebrow">MyBudget</span><h2>Caricamento del tuo spazio...</h2><p>Sto recuperando i dati protetti del tuo budget.</p></div></div></section></main>';
    return;
  }
  if (!state.sessionUserId) {
    app.innerHTML = renderLogin();
    return;
  }
  app.innerHTML = renderShell();
}

function renderLogin() {
  return `
    <main class="auth-page">
      <section class="auth-intro">
        <div class="brand brand-light"><span class="brand-mark">b</span><span>MyBudget</span></div>
        <div class="auth-intro-copy">
          <p class="eyebrow">Il tuo denaro, più semplice</p>
          <h1>Ogni euro al posto giusto.</h1>
          <p>Un luogo privato e condiviso per capire dove va il denaro, senza complicazioni.</p>
        </div>
        <div class="auth-art" aria-hidden="true"><span>€</span><i></i><i></i><i></i></div>
      </section>
      <section class="auth-card-wrap">
        <div class="auth-card">
          <div class="auth-card-heading"><span class="eyebrow">Bentornato</span><h2>Accedi al tuo spazio</h2><p>Inserisci le tue credenziali per continuare.</p></div>
          <form id="login-form" class="form-stack">
            <label>Email<input name="email" type="email" placeholder="nome@email.it" required /></label>
            <label>Password<div class="password-field"><input name="password" type="password" placeholder="••••••••" required /><button class="icon-button" type="button" data-action="toggle-password" aria-label="Mostra password">◉</button></div></label>
            <div class="form-row-between"><label class="check-label"><input type="checkbox" checked /> Ricordami</label><a href="#" data-action="forgot-password">Password dimenticata?</a></div>
            <button class="button button-primary button-block" type="submit">Accedi <span>→</span></button>
          </form>
          ${remoteMode ? '' : '<div class="auth-divider"><span>oppure</span></div><button class="button button-soft button-block" data-action="demo-login"><span class="sparkle">✦</span> Entra nella demo</button>'}
          <p class="auth-switch">Non hai ancora un account? <a href="#" data-action="show-register">Registrati</a></p>
        </div>
        <p class="demo-note"><span class="lock-icon">▣</span> ${remoteMode ? 'Accesso privato · dati protetti da Supabase' : 'Demo locale · nessun dato viene inviato online'}</p>
      </section>
    </main>`;
}

function renderShell() {
  const user = getUser();
  const page = state.currentPage;
  const admin = user?.role === 'admin';
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-top"><div class="brand"><span class="brand-mark">b</span><span>MyBudget</span></div>${remoteMode ? '' : '<span class="demo-badge">DEMO</span>'}</div>
        <div class="sidebar-user"><div class="avatar avatar-large">${initials(user)}</div><div><strong>${user.firstName} ${user.lastName}</strong><small>${user.role === 'admin' ? 'Amministratore' : 'Utente standard'}</small></div><button class="icon-button" data-action="logout" aria-label="Esci">↪</button></div>
        <nav class="main-nav" aria-label="Navigazione principale">
          <button class="nav-item ${page === 'dashboard' ? 'is-active' : ''}" data-page="dashboard"><span>◒</span> Dashboard</button>
          <button class="nav-item ${page === 'transactions' ? 'is-active' : ''}" data-page="transactions"><span>☷</span> Movimenti <em>${transactionsForBudget(state.selectedBudgetId).length}</em></button>
          <button class="nav-item ${page === 'budgets' ? 'is-active' : ''}" data-page="budgets"><span>▤</span> I tuoi budget <em>${state.budgets.length + state.archivedBudgets.length}</em></button>
          <button class="nav-item ${page === 'categories' ? 'is-active' : ''}" data-page="categories"><span>◇</span> Le mie categorie</button>
          <button class="nav-item ${page === 'paymentMethods' ? 'is-active' : ''}" data-page="paymentMethods"><span>◈</span> I miei metodi e conti</button>
          <div class="nav-label">Gestione</div>
          ${admin ? `<button class="nav-item ${page === 'admin' ? 'is-active' : ''}" data-page="admin"><span>⚙</span> Gestione utenti</button>` : ''}
          <button class="nav-item" data-action="export-data"><span>⌁</span> Esporta dati</button>
        </nav>
        <div class="sidebar-bottom"><div class="privacy-note"><span>✦</span><div><strong>I tuoi dati sono privati</strong><small>Protetti da permessi e database.</small></div></div><button class="help-link" data-action="coming-soon">? Hai bisogno di aiuto?</button></div>
      </aside>
      <div class="main-area">
        <header class="topbar"><button class="mobile-menu icon-button" data-action="toggle-sidebar" aria-label="Apri menu">☰</button><div class="breadcrumb"><span>Spazio personale</span><b>/</b><strong>${page === 'dashboard' ? 'Dashboard' : page === 'transactions' ? 'Movimenti' : page === 'budgets' ? 'I tuoi budget' : page === 'categories' ? 'Le mie categorie' : page === 'paymentMethods' ? 'I miei metodi e conti' : 'Amministrazione'}</strong></div><div class="topbar-actions"><button class="icon-button notification-button" data-action="coming-soon" aria-label="Notifiche">♧<i></i></button><div class="topbar-avatar avatar">${initials(user)}</div></div></header>
        <main class="content"><div class="content-inner">${page === 'dashboard' ? renderDashboard() : page === 'transactions' ? renderTransactions() : page === 'budgets' ? renderBudgets() : page === 'categories' ? renderCategories() : page === 'paymentMethods' ? renderPaymentMethods() : renderAdmin()}</div></main>
      </div>
    </div>
    <div id="modal-root"></div>`;
}

function renderBudgetCard(budget, archived = false) {
  const owner = getUser(budget.createdBy);
  const ownerLabel = isBudgetOwner(budget) ? 'Tu sei il proprietario' : `Condiviso da ${owner ? `${owner.firstName} ${owner.lastName}` : 'un altro utente'}`;
  const access = budgetAccessFor(budget.id);
  const actions = archived
    ? (isBudgetOwner(budget) ? `<button class="small-button" data-action="restore-budget" data-id="${budget.id}">Ripristina</button><button class="small-button danger-button" data-action="delete-budget" data-id="${budget.id}">Elimina</button>` : '')
    : `${isBudgetOwner(budget) ? `<button class="small-button" data-action="manage-budget-access" data-id="${budget.id}">Condivisione</button><button class="small-button" data-action="archive-budget" data-id="${budget.id}">Archivia</button><button class="small-button danger-button" data-action="delete-budget" data-id="${budget.id}">Elimina</button>` : '<span class="muted-small">Accesso condiviso</span>'}`;
  return `<article class="budget-management-card ${archived ? 'is-archived' : ''}"><div class="budget-card-heading"><span class="budget-color" style="--dot-color:${escapeHtml(budget.color || '#5e9b87')}"></span><div><h3>${escapeHtml(budget.name)}</h3><p>${ownerLabel}</p></div><span class="status-pill ${archived ? 'sospeso' : 'attivo'}">${archived ? 'Archiviato' : 'Attivo'}</span></div><div class="budget-card-meta"><span><strong>${budgetTransactionsCount(budget.id)}</strong> movimenti</span><span><strong>${budgetRecurringCount(budget.id)}</strong> ricorrenze</span><span><strong>${access.length || (isBudgetOwner(budget) ? 1 : 0)}</strong> accessi</span></div><div class="budget-card-actions">${actions}</div></article>`;
}

function renderBudgets() {
  const activeBudgets = state.budgets;
  const archivedBudgets = state.archivedBudgets;
  return `<section class="page-heading compact"><div><p class="eyebrow">Spazio personale</p><h1>I tuoi budget</h1><p class="page-subtitle">Crea e organizza i contenitori dei tuoi flussi di cassa. I budget condivisi restano separati dai tuoi dati personali.</p></div><button class="button button-primary" data-action="new-budget">＋ Nuovo budget</button></section><section class="budget-management-intro card"><div><span class="section-kicker">Un budget alla volta, tutto sotto controllo</span><h2>Gestisci i tuoi spazi</h2><p>Puoi archiviare un budget per nasconderlo senza perdere lo storico oppure eliminarlo definitivamente dopo aver verificato i dati collegati.</p></div><span class="budget-count-badge">${activeBudgets.length} attivi</span></section><section class="budget-management-list"><div class="section-heading"><div><span class="section-kicker">Disponibili</span><h2>I tuoi budget attivi</h2></div></div>${activeBudgets.length ? activeBudgets.map((budget) => renderBudgetCard(budget)).join('') : '<div class="card empty-state"><span>＋</span><strong>Nessun budget attivo</strong><p>Crea un budget per iniziare a registrare i movimenti.</p></div>'}</section>${archivedBudgets.length ? `<section class="budget-management-list archived-budget-list"><div class="section-heading"><div><span class="section-kicker">Conservati</span><h2>Budget archiviati</h2></div><span class="muted-small">Non compaiono nella Dashboard</span></div>${archivedBudgets.map((budget) => renderBudgetCard(budget, true)).join('')}</section>` : ''}`;
}

function renderCategories() {
  const budget = getBudget(state.categoryBudgetId) || getBudget();
  if (!budget) return `<section class="page-heading compact"><div><p class="eyebrow">Spazio personale</p><h1>Le mie categorie</h1><p class="page-subtitle">Crea prima un budget per organizzare le categorie.</p></div><button class="button button-primary" data-page="budgets">Vai a I tuoi budget <span>→</span></button></section><div class="card empty-state"><span>◇</span><strong>Nessun budget disponibile</strong><p>Le categorie vengono utilizzate all’interno dei tuoi budget.</p></div>`;

  const months = dashboardMonths();
  const currentKey = months.some((item) => item.key === state.categoryMonth) ? state.categoryMonth : DEFAULT_DASHBOARD_MONTH;
  const currentIndex = Math.max(0, months.findIndex((item) => item.key === currentKey));
  const view = state.categoryView === 'year' ? 'year' : 'month';
  const periodLabel = view === 'year' ? `Tutto il ${APP_YEAR}` : monthLabel(currentKey);
  const periodTransactions = transactionsForBudget(budget.id).filter((transaction) => view === 'year' ? transaction.date.startsWith(`${APP_YEAR}-`) : transaction.date.startsWith(currentKey));
  const visibleCategories = categoriesForBudget(budget.id).sort((a, b) => normalizeName(a.name).localeCompare(normalizeName(b.name), 'it'));
  const expense = periodTransactions.filter(isEffectiveExpense).reduce((sum, transaction) => sum + transaction.amount, 0);
  const income = periodTransactions.filter(isEffectiveIncome).reduce((sum, transaction) => sum + transaction.amount, 0);
  const plannedIncome = periodTransactions.filter(isPlannedIncome).reduce((sum, transaction) => sum + transaction.amount, 0);
  const usedCategories = visibleCategories.filter((category) => periodTransactions.some((transaction) => transaction.categoryId === category.id)).length;
  const canCreate = can('add', budget.id) || isBudgetOwner(budget);
  const categoryRows = visibleCategories.map((category) => {
    const transactions = periodTransactions.filter((transaction) => transaction.categoryId === category.id);
    const categoryExpense = transactions.filter(isEffectiveExpense).reduce((sum, transaction) => sum + transaction.amount, 0);
    const categoryIncome = transactions.filter(isEffectiveIncome).reduce((sum, transaction) => sum + transaction.amount, 0);
    const categoryPlannedIncome = transactions.filter(isPlannedIncome).reduce((sum, transaction) => sum + transaction.amount, 0);
    const usage = state.transactions.filter((transaction) => transaction.categoryId === category.id).length;
    const manageActions = canManageCategory(category) ? `<div class="category-row-actions"><button class="small-button" data-action="edit-category" data-id="${category.id}">Modifica</button><button class="small-button danger-button" data-action="archive-category" data-id="${category.id}">Archivia</button><button class="small-button danger-button" data-action="delete-category" data-id="${category.id}">Elimina</button></div>` : '<span class="muted-small category-readonly">Sola lettura</span>';
    const origin = category.default ? 'Predefinita' : category.ownerId === state.sessionUserId ? 'Personale' : 'Condivisa';
    return `<div class="category-management-row"><span class="category-icon mini-icon">${category.icon}</span><div class="category-row-name"><strong>${escapeHtml(category.name)}</strong><small>${origin} · ${usage} ${usage === 1 ? 'movimento' : 'movimenti'} complessivi${category.allowAttachments ? ' · 📎 Allegati attivi' : ''}</small></div><div class="category-row-totals"><span>Uscite<strong class="negative">${euro(categoryExpense)}</strong></span><span>Entrate<strong class="positive">${euro(categoryIncome)}</strong>${categoryPlannedIncome ? `<small>${euro(categoryPlannedIncome)} previste</small>` : ''}</span></div>${manageActions}</div>`;
  }).join('');

  return `<section class="page-heading compact"><div><p class="eyebrow">Organizzazione</p><h1>Le mie categorie</h1><p class="page-subtitle">Gestisci le categorie del budget senza perdere lo storico dei movimenti già registrati.</p></div>${canCreate ? '<button class="button button-primary" data-action="new-category">＋ Nuova categoria</button>' : '<span class="status-pill attivo">Sola visualizzazione</span>'}</section><section class="category-toolbar card"><div class="category-toolbar-field"><span class="label">Budget</span><label class="select-wrap"><span class="budget-dot" style="--dot-color:${escapeHtml(budget.color || '#5e9b87')}"></span><select data-change="category-budget">${state.budgets.map((item) => `<option value="${item.id}" ${item.id === budget.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select><span class="chevron">⌄</span></label></div><div class="category-period"><span class="label">Periodo</span><div class="category-period-controls"><button class="month-nav" data-action="category-month" data-direction="previous" aria-label="Mese precedente" ${view === 'month' && currentIndex > 0 ? '' : 'disabled'}>←</button><strong>${periodLabel}</strong><button class="month-nav" data-action="category-month" data-direction="next" aria-label="Mese successivo" ${view === 'month' && currentIndex < months.length - 1 ? '' : 'disabled'}>→</button></div><div class="period-switch"><button class="${view === 'month' ? 'is-active' : ''}" data-action="category-view" data-view="month">Mese</button><button class="${view === 'year' ? 'is-active' : ''}" data-action="category-view" data-view="year">Anno</button></div></div></section>${canCreate ? `<section class="card category-add-card"><div><span class="section-kicker">Aggiunta rapida</span><h2>Nuova categoria</h2><p class="muted-small">Le categorie personali saranno disponibili nei tuoi budget. Quelle predefinite non possono essere modificate.</p></div><form id="inline-category-form" class="category-add-row"><input type="hidden" name="budgetId" value="${budget.id}" /><input name="name" required maxlength="80" placeholder="Nome categoria" aria-label="Nome categoria" /><select name="type" aria-label="Tipo categoria"><option value="entrambi">Entrate e uscite</option><option value="entrata">Solo entrate</option><option value="uscita">Solo uscite</option></select><button type="submit" class="button button-primary">Aggiungi <span>→</span></button></form></section>` : ''}<section class="category-kpis"><div class="card category-kpi"><span>Uscite ${view === 'year' ? 'annue' : 'del mese'}</span><strong class="negative">${euro(expense)}</strong></div><div class="card category-kpi"><span>Entrate incassate</span><strong class="positive">${euro(income)}</strong></div><div class="card category-kpi"><span>Entrate previste</span><strong class="planned-text">${euro(plannedIncome)}</strong></div><div class="card category-kpi"><span>Categorie utilizzate</span><strong>${usedCategories} <small>/ ${visibleCategories.length}</small></strong></div></section><section class="card category-management-card"><div class="section-heading"><div><span class="section-kicker">${budget.name}</span><h2>Categorie disponibili</h2><p class="muted-small">${periodLabel} · le somme rispettano lo stato incassata/prevista.</p></div><span class="muted-small">${visibleCategories.length} ${visibleCategories.length === 1 ? 'categoria' : 'categorie'}</span></div><div class="category-management-list">${categoryRows || '<div class="empty-state"><span>◇</span><strong>Nessuna categoria disponibile</strong><p>Aggiungi la prima categoria dal modulo qui sopra.</p></div>'}</div></section>`;
}

const paymentMethodTransactions = (budgetId, methodId) => transactionsForBudget(budgetId).filter((transaction) => transactionPaymentMethodId(transaction) === methodId);
const paymentMethodBalance = (method, budgetId) => {
  const openingDate = method.openingDate || YEAR_START;
  const movements = paymentMethodTransactions(budgetId, method.id).filter((transaction) => !transaction.isProjected && transaction.date >= openingDate);
  return method.initialBalance + movements.filter(isEffectiveIncome).reduce((sum, transaction) => sum + transaction.amount, 0) - movements.filter(isEffectiveExpense).reduce((sum, transaction) => sum + transaction.amount, 0);
};

function renderPaymentMethods() {
  const budget = getBudget(state.paymentMethodBudgetId) || getBudget();
  if (!budget) return `<section class="page-heading compact"><div><p class="eyebrow">Organizzazione</p><h1>I miei metodi e conti</h1><p class="page-subtitle">Crea prima un budget per configurare contanti, carte e conti.</p></div><button class="button button-primary" data-page="budgets">Vai a I tuoi budget <span>→</span></button></section><div class="card empty-state"><span>◈</span><strong>Nessun budget disponibile</strong><p>I metodi e i conti vengono utilizzati all’interno dei tuoi budget.</p></div>`;
  const months = Array.from({ length: 12 }, (_, index) => ({ key: `${APP_YEAR}-${String(index + 1).padStart(2, '0')}` }));
  const currentKey = months.some((item) => item.key === state.paymentMethodMonth) ? state.paymentMethodMonth : DEFAULT_DASHBOARD_MONTH;
  const currentIndex = Math.max(0, months.findIndex((item) => item.key === currentKey));
  const periodTransactions = transactionsForBudget(budget.id).filter((transaction) => transaction.date.startsWith(currentKey));
  const methods = paymentMethodsForBudget(budget.id);
  const archivedMethods = paymentMethodsForBudget(budget.id, true).filter((method) => method.archived);
  const activeMethods = methods.filter((method) => !method.archived);
  const income = periodTransactions.filter(isEffectiveIncome).reduce((sum, transaction) => sum + transaction.amount, 0);
  const expense = periodTransactions.filter(isEffectiveExpense).reduce((sum, transaction) => sum + transaction.amount, 0);
  const canCreate = can('add', budget.id);
  const renderMethodCard = (method) => {
    const items = periodTransactions.filter((transaction) => transactionPaymentMethodId(transaction) === method.id);
    const methodIncome = items.filter(isEffectiveIncome).reduce((sum, transaction) => sum + transaction.amount, 0);
    const methodExpense = items.filter(isEffectiveExpense).reduce((sum, transaction) => sum + transaction.amount, 0);
    const methodPlanned = items.filter(isPlannedIncome).reduce((sum, transaction) => sum + transaction.amount, 0);
    const actions = method.default ? '<span class="status-pill attivo">Sempre disponibile</span>' : canManagePaymentMethod(method) ? `<div class="category-row-actions"><button class="small-button" data-action="edit-payment-method" data-id="${method.id}">Modifica</button><button class="small-button danger-button" data-action="archive-payment-method" data-id="${method.id}">Archivia</button></div>` : '<span class="muted-small category-readonly">Sola lettura</span>';
    return `<article class="payment-method-card ${method.default ? 'is-default' : ''}"><div class="payment-method-card-heading"><span class="payment-method-icon payment-method-icon-${method.kind === 'contanti' ? '0' : method.kind === 'paypal' ? '1' : method.kind === 'conto_bancario' ? '2' : '3'}">${method.default ? '•' : method.kind === 'contanti' ? '€' : method.kind === 'paypal' ? 'P' : '▣'}</span><div><h3>${escapeHtml(method.name)}</h3><p>${paymentMethodKindLabel(method.kind)} · Saldo iniziale ${euro(method.initialBalance)} al ${date(method.openingDate)}</p></div>${method.default ? '<span class="status-pill attivo">Opzionale</span>' : ''}</div><div class="payment-method-card-meta"><span>Periodo<strong class="positive">+${euro(methodIncome)}</strong> <strong class="negative">−${euro(methodExpense)}</strong>${methodPlanned ? `<small>${euro(methodPlanned)} previste</small>` : ''}</span><span>Saldo calcolato<strong class="${paymentMethodBalance(method, budget.id) >= 0 ? 'positive' : 'negative'}">${euro(paymentMethodBalance(method, budget.id))}</strong></span></div><div class="payment-method-card-actions">${actions}</div></article>`;
  };
  return `<section class="page-heading compact"><div><p class="eyebrow">Organizzazione</p><h1>I miei metodi e conti</h1><p class="page-subtitle">Scegli da dove parte o dove arriva ogni movimento. Il saldo iniziale viene usato come punto di partenza.</p></div>${canCreate ? `<button class="button button-primary" data-action="new-payment-method" data-budget-id="${budget.id}">＋ Nuovo metodo o conto</button>` : '<span class="status-pill attivo">Sola visualizzazione</span>'}</section><section class="category-toolbar card"><div class="category-toolbar-field"><span class="label">Budget</span><label class="select-wrap"><span class="budget-dot" style="--dot-color:${escapeHtml(budget.color || '#5e9b87')}"></span><select data-change="payment-method-budget">${state.budgets.map((item) => `<option value="${item.id}" ${item.id === budget.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select><span class="chevron">⌄</span></label></div><div class="category-period"><span class="label">Periodo</span><div class="category-period-controls"><button class="month-nav" data-action="payment-method-month" data-direction="previous" aria-label="Mese precedente" ${currentIndex > 0 ? '' : 'disabled'}>←</button><strong>${monthLabel(currentKey)}</strong><button class="month-nav" data-action="payment-method-month" data-direction="next" aria-label="Mese successivo" ${currentIndex < months.length - 1 ? '' : 'disabled'}>→</button></div></div></section><section class="category-kpis"><div class="card category-kpi"><span>Entrate del mese</span><strong class="positive">${euro(income)}</strong></div><div class="card category-kpi"><span>Uscite del mese</span><strong class="negative">${euro(expense)}</strong></div><div class="card category-kpi"><span>Saldo dei conti</span><strong class="${activeMethods.reduce((sum, method) => sum + paymentMethodBalance(method, budget.id), 0) >= 0 ? 'positive' : 'negative'}">${euro(activeMethods.reduce((sum, method) => sum + paymentMethodBalance(method, budget.id), 0))}</strong></div><div class="card category-kpi"><span>Metodi attivi</span><strong>${activeMethods.length}</strong></div></section><section class="card category-management-card"><div class="section-heading"><div><span class="section-kicker">${budget.name}</span><h2>Metodi e conti disponibili</h2><p class="muted-small">Il valore “Non specificato” resta sempre disponibile per chi non vuole usare questa funzione.</p></div><span class="muted-small">${activeMethods.length} ${activeMethods.length === 1 ? 'metodo' : 'metodi'}</span></div><div class="payment-method-list">${activeMethods.length ? activeMethods.map(renderMethodCard).join('') : '<div class="empty-state"><span>◈</span><strong>Nessun metodo configurato</strong><p>Aggiungi il primo metodo o usa “Non specificato”.</p></div>'}</div></section>${archivedMethods.length ? `<section class="card category-management-card archived-payment-methods"><div class="section-heading"><div><span class="section-kicker">Conservati</span><h2>Metodi archiviati</h2></div><span class="muted-small">Lo storico resta leggibile</span></div><div class="payment-method-list">${archivedMethods.map(renderMethodCard).join('')}</div></section>` : ''}`;
}

function renderDashboard() {
  const months = dashboardMonths();
  const current = months.find((item) => item.key === state.dashboardMonth) || months.find((item) => item.key === DEFAULT_DASHBOARD_MONTH) || months[0];
  const currentIndex = Math.max(0, months.findIndex((item) => item.key === current.key));
  const hasPreviousMonth = currentIndex > 0;
  const hasNextMonth = currentIndex < months.length - 1;
  const balance = current.income - current.expense;
  const plannedIncome = current.plannedIncome || 0;
  const budget = getBudget();
  if (!budget) return `<section class="page-heading"><div><p class="eyebrow">Spazio personale</p><h1>Benvenuto in MyBudget</h1><p class="page-subtitle">Crea il tuo primo budget per iniziare.</p></div><button class="button button-primary" data-page="budgets">Gestisci i tuoi budget <span>→</span></button></section><div class="empty-state"><span>＋</span><strong>Nessun budget attivo</strong><p>Vai in “I tuoi budget” per crearne uno nuovo o ripristinarne uno archiviato.</p></div>`;
  const max = Math.max(1, ...state.monthlySummary.map((item) => Math.max(item.income, item.expense)));
  const chartView = state.dashboardChartView === 'annual' ? 'annual' : 'monthly';
  const reportView = ['cashflow', 'categories', 'methods'].includes(state.dashboardReportView) ? state.dashboardReportView : 'cashflow';
  const budgetTransactions = transactionsForBudget(budget.id);
  const dashboardPeriod = chartView === 'annual' ? 'all' : current.key;
  const dashboardPeriodLabel = chartView === 'annual' ? 'Tutto il 2026' : monthLabel(current.key);
  const periodTransactions = chartView === 'annual' ? budgetTransactions : budgetTransactions.filter((tx) => tx.date.startsWith(current.key));
  const latest = [...budgetTransactions.filter((transaction) => !transaction.isProjected)].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  const periodExpense = periodTransactions.filter((tx) => tx.type === 'uscita').reduce((sum, tx) => sum + tx.amount, 0);
  const plannedExpense = current.plannedExpense || 0;
  const categoryTotals = state.categories.map((category) => ({ ...category, total: periodTransactions.filter((tx) => tx.categoryId === category.id && tx.type === 'uscita').reduce((sum, tx) => sum + tx.amount, 0) })).filter((category) => category.total > 0).sort((a, b) => b.total - a.total).slice(0, 4);
  return `
    <section class="page-heading"><div><p class="eyebrow">${formatLongLocalDate(APP_TODAY)}</p><h1>Buongiorno, ${getUser().firstName} <span class="wave">✦</span></h1><p class="page-subtitle">Ecco come sta andando ${monthLabel(current.key).toLowerCase()}.</p></div><div class="heading-actions">${can('add') ? '<button class="button button-primary" data-action="new-transaction"><span>＋</span> Nuovo movimento</button>' : '<span class="status-pill attivo">Sola visualizzazione</span>'}</div></section>
    <section class="overview-row"><div class="budget-picker card"><span class="label">Stai guardando</span><label class="select-wrap"><span class="budget-dot" style="--dot-color:${budget.color}"></span><select data-change="budget">${state.budgets.map((item) => `<option value="${item.id}" ${item.id === budget.id ? 'selected' : ''}>${item.name}</option>`).join('')}</select><span class="chevron">⌄</span></label><div class="dashboard-month-control"><span class="label">Periodo</span><div class="month-navigation"><button class="month-nav" data-action="dashboard-month" data-direction="previous" aria-label="Mese precedente" ${hasPreviousMonth ? '' : 'disabled'}>←</button><strong>${monthLabel(current.key)}</strong><button class="month-nav" data-action="dashboard-month" data-direction="next" aria-label="Mese successivo" ${hasNextMonth ? '' : 'disabled'}>→</button></div></div><span class="muted-small">Tutti i 12 mesi esplorabili</span></div><button class="stat-card card dashboard-link" data-action="dashboard-filter" data-period="${current.key}" data-type="entrata" data-income-status="effective" aria-label="Apri le entrate effettive di ${monthLabel(current.key)}"><div class="stat-top"><span>Entrate effettive</span><span class="stat-icon income">↑</span></div><strong>${euro(current.income)}</strong><small class="trend positive">Incassate nel mese · Vedi movimenti →</small></button><button class="stat-card card stat-planned dashboard-link" data-action="dashboard-filter" data-period="${current.key}" data-type="entrata" data-income-status="planned" aria-label="Apri le entrate previste di ${monthLabel(current.key)}"><div class="stat-top"><span>Entrate previste</span><span class="stat-icon planned">◷</span></div><strong>${euro(plannedIncome)}</strong><small class="trend neutral">Non incluse nel saldo · Vedi movimenti →</small></button><button class="stat-card card dashboard-link" data-action="dashboard-filter" data-period="${current.key}" data-type="uscita" aria-label="Apri le uscite di ${monthLabel(current.key)}"><div class="stat-top"><span>Uscite del mese</span><span class="stat-icon expense">↓</span></div><strong>${euro(current.expense)}</strong><small class="trend negative">Pagate nel mese${plannedExpense ? ` · ${euro(plannedExpense)} previste` : ''} · Vedi movimenti →</small></button><button class="stat-card card stat-balance dashboard-link" data-action="dashboard-filter" data-period="${current.key}" data-type="all" aria-label="Apri tutti i movimenti di ${monthLabel(current.key)}"><div class="stat-top"><span>Saldo disponibile</span><span class="stat-icon balance">=</span></div><strong>${euro(balance)}</strong><small class="trend positive">Entrate effettive − uscite · Vedi movimenti →</small></button></section>
    <section class="dashboard-grid"><div class="card chart-card"><div class="section-heading chart-heading"><div><div class="chart-title-line"><span class="section-kicker">Report</span><span class="chart-navigation"><button class="chart-nav" data-action="toggle-dashboard-chart" data-direction="previous" aria-label="Vista precedente">←</button><span>${chartView === 'annual' ? 'Totale annuo' : 'Vista mensile'}</span><button class="chart-nav" data-action="toggle-dashboard-chart" data-direction="next" aria-label="Vista successiva">→</button></span></div><h2>${reportView === 'methods' ? 'Metodi e conti' : reportView === 'categories' ? 'Categorie' : chartView === 'annual' ? 'Disponibilità annuale' : 'Entrate e uscite'}</h2></div><span class="chart-period">${dashboardPeriodLabel} <span>⌄</span></span></div><div class="dashboard-report-switch" role="tablist" aria-label="Tipo di report"><button class="${reportView === 'cashflow' ? 'is-active' : ''}" data-action="dashboard-report-view" data-view="cashflow" role="tab" aria-selected="${reportView === 'cashflow'}">Andamento</button><button class="${reportView === 'categories' ? 'is-active' : ''}" data-action="dashboard-report-view" data-view="categories" role="tab" aria-selected="${reportView === 'categories'}">Per categoria</button><button class="${reportView === 'methods' ? 'is-active' : ''}" data-action="dashboard-report-view" data-view="methods" role="tab" aria-selected="${reportView === 'methods'}">Per conto</button></div>${renderDashboardReport(reportView, budget, periodTransactions, dashboardPeriodLabel, dashboardPeriod, max)}</div><div class="card impact-card"><div class="section-heading"><div><span class="section-kicker">Dove spendi di più</span><h2>Categorie principali</h2><small class="card-context">${dashboardPeriodLabel}</small></div><button class="text-button" data-action="dashboard-filter" data-period="${dashboardPeriod}" data-type="uscita">Vedi tutto →</button></div><div class="impact-list">${categoryTotals.map((category, index) => `<div class="impact-row" data-action="dashboard-filter" data-period="${dashboardPeriod}" data-type="uscita" data-category="${category.id}" role="button" tabindex="0"><span class="category-icon icon-${index}">${category.icon}</span><div class="impact-name"><strong>${category.name}</strong><small>${Math.round(category.total / periodExpense * 100)}% delle uscite</small></div><div class="impact-value"><strong>${euro(category.total)}</strong><span class="impact-meter"><i style="width:${Math.min(100, category.total / categoryTotals[0].total * 100)}%"></i></span></div></div>`).join('')}</div></div></section>
    <section class="bottom-grid"><div class="card transactions-preview"><div class="section-heading"><div><span class="section-kicker">Attività recente</span><h2>Ultimi movimenti</h2></div><button class="text-button" data-page="transactions">Tutti i movimenti →</button></div><div class="mini-transactions">${latest.map(renderTransactionRow).join('')}</div></div><div class="card alerts-card"><div class="section-heading"><div><span class="section-kicker">Tieni d'occhio</span><h2>Avvisi del mese</h2></div><span class="alert-count">2</span></div><div class="alert-item warning"><span class="alert-symbol">!</span><div><strong>Cene fuori</strong><p>Hai superato il limite di ${euro(180)}.</p></div><button data-action="coming-soon">→</button></div><div class="alert-item info"><span class="alert-symbol">✦</span><div><strong>Stai andando bene</strong><p>Il tuo saldo è positivo da 4 mesi.</p></div><button data-action="coming-soon">→</button></div></div></section>`;
}

function renderTransactionRow(transaction) {
  const category = getCategory(transaction.categoryId);
  const paymentMethod = getPaymentMethod(transactionPaymentMethodId(transaction));
  const planned = isPlannedTransaction(transaction);
  const tone = planned ? 'planned' : transaction.type === 'entrata' ? 'income' : 'expense';
  const status = planned ? '<span class="transaction-status planned">Prevista</span>' : transaction.type === 'entrata' ? '<span class="transaction-status received">Incassata</span>' : '';
  const recurrenceStatus = transaction.recurring ? '<span class="transaction-status recurring">Ricorrente</span>' : '';
  return `<div class="transaction-row transaction-${tone}"><span class="category-icon mini-icon">${category?.icon || '•'}</span><div class="transaction-main"><strong>${transaction.description}</strong><small class="transaction-meta">${category?.name || 'Senza categoria'} · ${paymentMethod?.name || 'Non specificato'} · ${date(transaction.date)} ${status} ${recurrenceStatus}</small></div><strong class="transaction-amount ${transaction.type} ${planned ? 'planned' : ''}">${transaction.type === 'entrata' ? '+' : '−'}${euro(transaction.amount)}</strong></div>`;
}

function renderMonthlyTotals(income, plannedIncome, expense, plannedExpense) {
  return '<section class="movement-totals"><div class="movement-total income-total"><span>Entrate incassate</span><strong>' + euro(income) + '</strong></div><div class="movement-total planned-income-total"><span>Entrate previste</span><strong>' + euro(plannedIncome) + '</strong></div><div class="movement-total expense-total"><span>Uscite del periodo</span><strong>' + euro(expense) + '</strong>' + (plannedExpense ? '<small>' + euro(plannedExpense) + ' previste</small>' : '') + '</div><div class="movement-total balance-total"><span>Saldo effettivo</span><strong>' + euro(income - expense) + '</strong></div></section>';
}

function renderTransactions() {
  const budget = getBudget();
  if (!budget) return `<section class="page-heading compact"><div><p class="eyebrow">Spazio personale</p><h1>Movimenti</h1><p class="page-subtitle">Prima crea o ripristina un budget per poter registrare i movimenti.</p></div><button class="button button-primary" data-page="budgets">Vai a I tuoi budget <span>→</span></button></section><div class="card empty-state"><span>◌</span><strong>Nessun budget attivo</strong><p>La lista movimenti sarà disponibile dopo la creazione del primo budget.</p></div>`;
  const filters = { paymentMethod: 'all', ...state.transactionFilters };
  const incomeStatus = filters.incomeStatus || 'all';
  const all = transactionsForBudget(budget.id);
  const filtered = all.filter((tx) => (filters.month === 'all' || tx.date.startsWith(filters.month)) && (filters.type === 'all' || tx.type === filters.type) && (incomeStatus === 'all' || tx.type !== 'entrata' || (incomeStatus === 'effective' && isEffectiveIncome(tx)) || (incomeStatus === 'planned' && isPlannedIncome(tx))) && (filters.category === 'all' || tx.categoryId === filters.category) && (filters.paymentMethod === 'all' || transactionPaymentMethodId(tx) === filters.paymentMethod) && (`${tx.description} ${getCategory(tx.categoryId)?.name || ''} ${getPaymentMethod(transactionPaymentMethodId(tx))?.name || ''}`.toLowerCase().includes(filters.query.toLowerCase()))).sort((a, b) => b.date.localeCompare(a.date));
  const plannedIncome = filtered.filter(isPlannedIncome).reduce((sum, tx) => sum + tx.amount, 0);
  const income = filtered.filter(isEffectiveIncome).reduce((sum, tx) => sum + tx.amount, 0);
  const expense = filtered.filter(isEffectiveExpense).reduce((sum, tx) => sum + tx.amount, 0);
  const plannedExpense = filtered.filter((tx) => tx.type === 'uscita' && isProjectedTransaction(tx)).reduce((sum, tx) => sum + tx.amount, 0);
  const summaryTypes = filters.type === 'entrata' ? ['entrata'] : filters.type === 'uscita' ? ['uscita'] : ['entrata', 'uscita'];
  const categoriesForType = (type) => [...new Set(all.map((tx) => tx.categoryId))].map((id) => ({ ...getCategory(id), total: filtered.filter((tx) => tx.categoryId === id && tx.type === type).reduce((sum, tx) => sum + tx.amount, 0) })).filter((item) => item.total > 0 && item.name).sort((a, b) => b.total - a.total);
  const summaryGroups = summaryTypes.map((type) => {
    const categories = categoriesForType(type);
    const total = filtered.filter((tx) => tx.type === type).reduce((sum, tx) => sum + tx.amount, 0);
    const label = type === 'entrata' ? 'Entrate' : 'Uscite';
    const emptyLabel = type === 'entrata' ? 'entrate' : 'uscite';
    const footerClass = type === 'entrata' ? 'entrata-summary' : 'uscita-summary';
    return `<div class="summary-group"><div class="summary-group-heading"><span>${label}</span><strong>${euro(total)}</strong></div>${categories.map((category) => `<div class="summary-row" data-category="${category.id}" data-summary-type="${type}" role="button" tabindex="0"><span class="category-icon mini-icon">${category.icon}</span><span>${category.name}</span><strong>${euro(category.total)}</strong></div>`).join('') || `<p class="muted-small summary-empty">Nessuna ${emptyLabel} nel periodo.</p>`}<div class="summary-footer ${footerClass}"><span>Totale ${label.toLowerCase()}</span><strong>${euro(total)}</strong></div></div>`;
  }).join('');
  const summaryContext = filters.type === 'entrata' ? 'Entrate' : filters.type === 'uscita' ? 'Uscite' : 'Entrate e uscite';
  const movementButton = can('add') ? '<button class="button button-primary" data-action="new-transaction"><span>＋</span> Nuovo movimento</button>' : '';
  const importButton = can('add') ? '<button class="button button-soft" data-action="open-import"><span>⇧</span> Importa Excel</button>' : '';
  const transactionActions = (tx) => {
    if (tx.isProjected) {
      return canManageProjectedOccurrence(tx) ? `<div class="transaction-actions"><button class="icon-button" data-action="materialize-projected" data-id="${tx.id}" aria-label="${tx.type === 'entrata' ? 'Segna come incassata' : 'Segna come pagata'}" title="${tx.type === 'entrata' ? 'Segna come incassata' : 'Segna come pagata'}">✓</button><button class="icon-button" data-action="edit-transaction" data-id="${tx.id}" aria-label="Modifica questa occorrenza" title="Modifica questa occorrenza">✎</button><button class="icon-button danger-hover" data-action="delete-transaction" data-id="${tx.id}" aria-label="Salta questa occorrenza" title="Salta questa occorrenza">⌫</button></div>` : '<span class="projected-note">Previsto</span>';
    }
    const attachmentCount = (state.attachments || []).filter((item) => item.transactionId === tx.id).length;
    const attachmentButton = remoteMode && attachmentsFeatureAvailable && attachmentCount ? `<button class="icon-button attachment-icon-button" data-action="view-transaction-attachments" data-id="${tx.id}" aria-label="Mostra ${attachmentCount} allegati" title="Mostra ${attachmentCount} allegati">📎</button>` : '';
    return `<div class="transaction-actions">${attachmentButton}<button class="icon-button" data-action="edit-transaction" data-id="${tx.id}" aria-label="Modifica movimento">✎</button>${canDeleteTransaction(tx) ? `<button class="icon-button danger-hover" data-action="delete-transaction" data-id="${tx.id}" aria-label="Elimina movimento" title="Elimina movimento">⌫</button>` : ''}</div>`;
  };
  return `<section class="page-heading compact"><div><p class="eyebrow">${budget.name}</p><h1>Movimenti</h1><p class="page-subtitle">Tieni traccia di ogni entrata e ogni uscita.</p></div><div class="heading-actions">${importButton}${movementButton}</div></section>${renderMonthlyTotals(income, plannedIncome, expense, plannedExpense)}<section class="card filters-card"><div class="filters-top"><div class="filter-title"><span class="filter-icon">☷</span><div><strong>Filtra i movimenti</strong><small>Stai visualizzando ${filtered.length} movimenti</small></div></div><button class="text-button" data-action="clear-filters">Pulisci filtri</button></div><div class="filters-grid"><label>Periodo<select data-filter="month"><option value="all">Tutto il 2026</option>${state.monthlySummary.map((m) => `<option value="${m.key}" ${filters.month === m.key ? 'selected' : ''}>${monthLabel(m.key)}</option>`).join('')}</select></label><label>Tipo<select data-filter="type"><option value="all">Entrate e uscite</option><option value="entrata" ${filters.type === 'entrata' ? 'selected' : ''}>Solo entrate</option><option value="uscita" ${filters.type === 'uscita' ? 'selected' : ''}>Solo uscite</option></select></label><label>Stato entrate<select data-filter="incomeStatus"><option value="all" ${incomeStatus === 'all' ? 'selected' : ''}>Tutte le entrate</option><option value="effective" ${incomeStatus === 'effective' ? 'selected' : ''}>Solo incassate</option><option value="planned" ${incomeStatus === 'planned' ? 'selected' : ''}>Solo previste</option></select></label><label>Categoria<select data-filter="category"><option value="all">Tutte le categorie</option>${categoriesForBudget(budget.id).map((c) => `<option value="${c.id}" ${filters.category === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select></label><label>Metodo / conto<select data-filter="paymentMethod"><option value="all">Tutti i metodi e conti</option>${paymentMethodsForBudget(budget.id).map((method) => `<option value="${method.id}" ${filters.paymentMethod === method.id ? 'selected' : ''}>${escapeHtml(method.name)}</option>`).join('')}</select></label><label class="search-field">Cerca<input data-filter="query" value="${escapeHtml(filters.query)}" placeholder="Descrizione, categoria o conto..." /><span>⌕</span></label></div></section><section class="transaction-layout"><div class="card transaction-list-card"><div class="list-heading"><div><span class="section-kicker">Lista movimenti</span><h2>${filters.month === 'all' ? 'Tutto il 2026' : monthLabel(filters.month)}</h2></div><span class="list-total">Saldo <strong class="${income - expense >= 0 ? 'positive' : 'negative'}">${euro(income - expense)}</strong></span></div><div class="full-transactions">${filtered.length ? filtered.map((tx) => `<div class="full-transaction-row">${renderTransactionRow(tx)}${transactionActions(tx)}</div>`).join('') : '<div class="empty-state"><span>◌</span><strong>Nessun movimento trovato</strong><p>Prova a modificare i filtri oppure aggiungi un nuovo movimento.</p></div>'}</div></div><div class="card category-summary"><div class="section-heading"><div><span class="section-kicker">Riepilogo</span><h2>Per categoria</h2><small class="card-context">${summaryContext} · ${filters.month === 'all' ? 'Tutto il 2026' : monthLabel(filters.month)}${filters.paymentMethod !== 'all' ? ` · ${escapeHtml(getPaymentMethod(filters.paymentMethod)?.name || '')}` : ''}</small></div></div><div class="summary-groups">${summaryGroups}</div></div></section>`;
}

function renderAdmin() {
  if (!remoteMode) {
    const allBudgets = [...state.budgets, ...state.archivedBudgets];
    state.adminBudgetSummaries = state.profiles.flatMap((profile) => allBudgets.filter((budget) => budget.createdBy === profile.id).map((budget) => ({ userId: profile.id, firstName: profile.firstName, lastName: profile.lastName, email: profile.email, status: profile.status, budgetId: budget.id, budgetName: budget.name, budgetColor: budget.color, budgetCreatedBy: budget.createdBy, archivedAt: budget.archivedAt, memberCount: state.budgetMembers.filter((member) => member.budgetId === budget.id).length, transactionCount: budgetTransactionsCount(budget.id), recurringCount: budgetRecurringCount(budget.id) })));
  }
  const pending = state.profiles.filter((profile) => profile.status === 'in_attesa');
  const customCategories = state.categories.filter((category) => !category.default);
  const activeTab = state.adminTab || 'users';
  const userRows = state.profiles.map((profile) => {
    const action = profile.id === state.sessionUserId ? '' : profile.status === 'attivo'
      ? '<button class="small-button" data-action="toggle-user" data-id="' + profile.id + '" data-status="sospeso">Disabilita</button>'
      : '<button class="small-button" data-action="toggle-user" data-id="' + profile.id + '" data-status="attivo">' + (profile.status === 'in_attesa' ? 'Approva' : 'Riabilita') + '</button>';
    const userBudgets = state.adminBudgetSummaries.filter((item) => item.userId === profile.id && item.budgetId);
    const budgetSummary = userBudgets.length ? `<div class="admin-user-budgets">${userBudgets.map((item) => `<div class="admin-budget-summary"><span class="budget-color" style="--dot-color:${escapeHtml(item.budgetColor || '#5e9b87')}"></span><div><strong>${escapeHtml(item.budgetName)}</strong><small>${item.archivedAt ? 'Archiviato' : 'Attivo'} · ${item.transactionCount} movimenti · ${item.memberCount} accessi</small></div><button class="small-button" data-action="admin-archive-budget" data-id="${item.budgetId}" data-name="${escapeHtml(item.budgetName)}" ${item.archivedAt ? 'disabled' : ''}>${item.archivedAt ? 'Archiviato' : 'Archivia'}</button><button class="small-button danger-button" data-action="admin-delete-budget" data-id="${item.budgetId}" ${item.budgetId ? '' : 'disabled'}>Elimina</button></div>`).join('')}</div>` : '<p class="muted-small admin-no-budgets">Nessun budget associato.</p>';
    return '<div class="user-row admin-user-row"><div class="avatar">' + initials(profile) + '</div><div class="user-details"><strong>' + profile.firstName + ' ' + profile.lastName + '</strong><small>' + (profile.email || 'Email non disponibile') + '</small></div><span class="status-pill ' + profile.status + '">' + profile.status.replace('_', ' ') + '</span>' + action + `<button class="small-button" data-action="new-admin-budget" data-user-id="${profile.id}">＋ Budget</button>${budgetSummary}</div>`;
  }).join('');
  const categoryRows = customCategories.length ? customCategories.map((category) => {
    const owner = getUser(category.ownerId);
    return '<div class="category-report-row"><span class="category-icon mini-icon">' + category.icon + '</span><div><strong>' + category.name + '</strong><small>' + category.type + '</small></div><div><strong>' + (owner ? owner.firstName + ' ' + owner.lastName : 'Utente') + '</strong><small>' + (owner?.email || 'Email non disponibile') + '</small></div><span class="muted-small">' + (category.createdAt ? date(category.createdAt.slice(0, 10)) : '—') + '</span></div>';
  }).join('') : '<p class="muted-small">Nessuna categoria personalizzata.</p>';
  const usersPanel = '<section class="card admin-users"><div class="section-heading"><div><span class="section-kicker">Accessi</span><h2>Utenti della piattaforma</h2><p class="muted-small">Le richieste pending compaiono qui anche prima dell’approvazione.</p></div><div class="heading-actions"><button class="button button-soft" data-action="sync-admin-users">↻ Aggiorna richieste</button><button class="button button-primary" data-action="new-user">＋ Nuovo utente</button></div></div>' + userRows + '</section>';
  const categoriesPanel = '<section class="card admin-users"><div class="section-heading"><div><span class="section-kicker">Monitoraggio</span><h2>Categorie aggiunte</h2><p class="muted-small">Puoi vedere chi ha creato ogni categoria personalizzata.</p></div></div><div class="category-report"><div class="category-report-header"><span>Categoria</span><span>Creata da</span><span>Data</span></div>' + categoryRows + '</div></section>';
  return '<section class="page-heading compact"><div><p class="eyebrow">Controllo accessi</p><h1>Gestione utenti</h1><p class="page-subtitle">Crea, abilita o disabilita gli account e monitora le categorie create.</p></div><span class="status-pill attivo">Solo amministrazione</span></section><div class="admin-tabs"><button class="admin-tab ' + (activeTab === 'users' ? 'is-active' : '') + '" data-admin-tab="users">Utenti <em>' + pending.length + '</em></button><button class="admin-tab ' + (activeTab === 'categories' ? 'is-active' : '') + '" data-admin-tab="categories">Categorie</button></div><section class="admin-grid">' + (activeTab === 'users' ? usersPanel : categoriesPanel) + '</section>';
}

function renderBudgetAccessRows(budget, access) {
  const owner = getUser(budget.createdBy);
  const ownerRow = `<div class="access-row"><div class="avatar">${owner ? initials(owner) : 'TU'}</div><div><strong>${owner ? `${escapeHtml(owner.firstName)} ${escapeHtml(owner.lastName)}` : 'Proprietario'}</strong><small>${escapeHtml(owner?.email || 'Proprietario del budget')}</small></div><span class="status-pill attivo">Proprietario</span></div>`;
  const memberRows = access.filter((item) => item.userId !== budget.createdBy).map((item) => {
    const level = item.canEdit ? 'edit' : item.canAdd ? 'add' : 'view';
    return `<div class="access-row"><div class="avatar">${initials({ firstName: item.firstName || 'U', lastName: item.lastName || 't' })}</div><div><strong>${escapeHtml(`${item.firstName || ''} ${item.lastName || ''}`.trim() || 'Utente')}</strong><small>${escapeHtml(item.email || 'Email non disponibile')}</small></div><select data-access-level data-budget-id="${budget.id}" data-user-id="${item.userId}" aria-label="Permessi di ${escapeHtml(item.email || 'utente')}"><option value="view" ${level === 'view' ? 'selected' : ''}>Solo visualizzazione</option><option value="add" ${level === 'add' ? 'selected' : ''}>Visualizza e aggiungi</option><option value="edit" ${level === 'edit' ? 'selected' : ''}>Modifica movimenti</option></select><button class="small-button danger-button" data-action="remove-budget-access" data-budget-id="${budget.id}" data-user-id="${item.userId}">Rimuovi</button></div>`;
  }).join('');
  return ownerRow + (memberRows || '<p class="muted-small access-empty">Nessun altro utente ha accesso a questo budget.</p>');
}

async function openBudgetAccessModal(budgetId) {
  const budget = getAnyBudget(budgetId);
  if (!budget || !isBudgetOwner(budget)) return showToast('Solo il proprietario può gestire la condivisione.', 'error');
  let access = budgetAccessFor(budget.id);
  if (remoteMode) {
    const { data, error } = await supabase.rpc('list_budget_access', { p_budget_id: budget.id });
    if (error) return showToast(`Impossibile caricare gli accessi: ${error.message}`, 'error');
    access = (data || []).map((item) => ({ userId: item.user_id, firstName: item.first_name, lastName: item.last_name, email: item.email, canView: item.can_view, canAdd: item.can_add, canEdit: item.can_edit }));
    state.budgetAccess[budget.id] = access;
  }
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal budget-access-modal" role="dialog" aria-modal="true" data-stop-propagation><div class="modal-header"><div><span class="section-kicker">Budget condiviso</span><h2>${escapeHtml(budget.name)}</h2></div><button class="icon-button" data-action="close-modal" aria-label="Chiudi">×</button></div><p class="modal-intro">Invita un utente tramite email e scegli cosa potrà fare. L’amministratore non riceve accesso ai movimenti.</p><div class="access-list">${renderBudgetAccessRows(budget, access)}</div><form id="share-budget-form" class="share-form"><input type="hidden" name="budgetId" value="${budget.id}" /><div class="form-grid"><label>Email utente<input name="email" type="email" required placeholder="utente@email.it" /></label><label>Permessi<select name="level"><option value="view">Solo visualizzazione</option><option value="add">Visualizza e aggiungi</option><option value="edit">Modifica movimenti</option></select></label></div><div class="modal-actions"><button type="button" class="button button-soft" data-action="close-modal">Chiudi</button><button type="submit" class="button button-primary">Condividi budget <span>→</span></button></div></form></section></div>`;
}

async function openBudgetActionModal(budgetId, operation, actor = 'owner') {
  const budget = getAnyBudget(budgetId);
  const isAdminAction = actor === 'admin' && getUser()?.role === 'admin';
  if (!budget || (!isBudgetOwner(budget) && !isAdminAction)) return showToast('Non hai i permessi per eseguire questa operazione.', 'error');
  let counts = { transactions: budgetTransactionsCount(budget.id), recurring: budgetRecurringCount(budget.id), members: budgetAccessFor(budget.id).length, categories: budgetCategoryCount(budget.id) };
  if (remoteMode) {
    const { data, error } = await supabase.rpc(isAdminAction ? 'admin_budget_delete_preview' : 'budget_delete_preview', { p_budget_id: budget.id });
    if (error) return showToast(`Impossibile verificare il budget: ${error.message}`, 'error');
    counts = { transactions: Number(data?.transactions || 0), recurring: Number(data?.recurring_transactions || 0), members: Number(data?.members || 0), categories: Number(data?.categories || 0) };
  }
  const isArchive = operation === 'archive';
  const title = isArchive ? 'Archivia budget' : 'Elimina budget definitivamente';
  const description = isArchive ? 'Il budget sparirà dalla Dashboard ma conserverà tutti i dati e potrà essere ripristinato.' : 'Questa operazione cancellerà il budget e i dati collegati. Non sarà possibile recuperarlo senza un backup.';
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal danger-modal" role="dialog" aria-modal="true" data-stop-propagation><div class="modal-header"><div><span class="section-kicker">Attenzione</span><h2>${title}</h2></div><button class="icon-button" data-action="close-modal" aria-label="Chiudi">×</button></div><p class="modal-intro">${description}</p><div class="delete-stats"><div><strong>${counts.transactions}</strong><span>movimenti</span></div><div><strong>${counts.recurring}</strong><span>ricorrenze</span></div><div><strong>${counts.categories}</strong><span>categorie</span></div><div><strong>${counts.members}</strong><span>accessi</span></div></div><form id="budget-action-form" class="form-stack"><input type="hidden" name="budgetId" value="${budget.id}" /><input type="hidden" name="operation" value="${operation}" /><input type="hidden" name="actor" value="${actor}" /><label class="check-label"><input name="confirm" type="checkbox" required /> Ho letto le conseguenze di questa operazione</label><label>Per confermare, scrivi <strong>${escapeHtml(budget.name)}</strong><input name="confirmation" required autocomplete="off" placeholder="Nome del budget" /></label><div class="modal-actions"><button type="button" class="button button-soft" data-action="close-modal">Annulla</button><button type="submit" class="button ${isArchive ? 'button-primary' : 'button-danger'}">${isArchive ? 'Archivia budget' : 'Elimina definitivamente'}</button></div></form></section></div>`;
}

function openAdminBudgetModal(userId) {
  if (getUser()?.role !== 'admin') return showToast('Solo l’amministratore può creare budget per un utente.', 'error');
  const profile = getUser(userId);
  if (!profile) return showToast('Utente non trovato.', 'error');
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" data-stop-propagation><div class="modal-header"><div><span class="section-kicker">Gestione amministrativa</span><h2>Nuovo budget per ${escapeHtml(profile.firstName)}</h2></div><button class="icon-button" data-action="close-modal" aria-label="Chiudi">×</button></div><form id="admin-budget-form" class="form-stack"><input type="hidden" name="userId" value="${profile.id}" /><label>Nome budget<input name="name" required placeholder="Es. Personale, Casa, Lavoro" /></label><label>Colore<input name="color" type="color" value="#5e9b87" /></label><p class="muted-small">Il budget sarà creato per l’utente selezionato. Potrà usarlo, mentre tu ne vedrai soltanto nome, stato e conteggi organizzativi.</p><div class="modal-actions"><button type="button" class="button button-soft" data-action="close-modal">Annulla</button><button type="submit" class="button button-primary">Crea budget <span>→</span></button></div></form></section></div>`;
}



function openBudgetModal() {
  document.querySelector('#modal-root').innerHTML = '<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" data-stop-propagation><div class="modal-header"><div><span class="section-kicker">Organizza</span><h2>Nuovo budget</h2></div><button class="icon-button" data-action="close-modal" aria-label="Chiudi">×</button></div><form id="budget-form" class="form-stack"><label>Nome budget<input name="name" required placeholder="Es. Lavoro, Figlio, Casa" /></label><label>Colore<input name="color" type="color" value="#5e9b87" /></label><p class="muted-small">Il nuovo budget sarà associato solo al tuo account.</p><div class="modal-actions"><button type="button" class="button button-soft" data-action="close-modal">Annulla</button><button type="submit" class="button button-primary">Crea budget <span>→</span></button></div></form></section></div>';
}

function openUserModal() {
  if (getUser()?.role !== 'admin') return showToast('Solo l’amministratore può creare utenti.', 'error');
  document.querySelector('#modal-root').innerHTML = '<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" data-stop-propagation><div class="modal-header"><div><span class="section-kicker">Accessi</span><h2>Nuovo utente</h2></div><button class="icon-button" data-action="close-modal" aria-label="Chiudi">×</button></div><form id="user-create-form" class="form-stack"><div class="form-grid"><label>Nome<input name="firstName" required placeholder="Nome" /></label><label>Cognome<input name="lastName" required placeholder="Cognome" /></label></div><label>Email<input name="email" type="email" required placeholder="nome@email.it" /></label><label>Password iniziale<input name="password" type="password" minlength="8" required placeholder="Almeno 8 caratteri" /></label><p class="muted-small">L’account verrà creato come “in attesa”. Dopo la creazione potrai approvarlo dalla lista utenti. Comunica la password iniziale all’utente, che potrà poi usare il recupero password.</p><div class="modal-actions"><button type="button" class="button button-soft" data-action="close-modal">Annulla</button><button type="submit" class="button button-primary">Crea utente <span>→</span></button></div></form></section></div>';
}

const readTransactionDraft = (form) => {
  const values = new FormData(form);
  return {
    id: String(values.get('id') || ''),
    type: String(values.get('type') || 'uscita'),
    amount: String(values.get('amount') || ''),
    date: String(values.get('date') || APP_TODAY),
    budgetId: String(values.get('budgetId') || state.selectedBudgetId || ''),
    categoryId: String(values.get('categoryId') || ''),
    paymentMethodId: String(values.get('paymentMethodId') || ''),
    description: String(values.get('description') || ''),
    recurring: values.get('recurring') === 'on',
    frequency: String(values.get('frequency') || 'mensile'),
    day: String(values.get('day') || '1'),
    endDate: String(values.get('endDate') || ''),
    isReceived: values.get('isReceived') === 'on',
  };
};

function openCategoryModal(options = {}) {
  const fromMovement = Boolean(options.fromMovement || pendingMovementDraft);
  const budget = getBudget(options.budgetId || pendingMovementDraft?.budgetId || state.selectedBudgetId);
  if (!budget || !can('add', budget.id)) return showToast('Per creare una categoria devi poter inserire movimenti in questo budget.', 'error');
  document.querySelector('#modal-root').innerHTML = '<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" data-stop-propagation data-return-to-movement="' + (fromMovement ? 'true' : 'false') + '"><div class="modal-header"><div><span class="section-kicker">Personalizza</span><h2>Nuova categoria</h2></div><button class="icon-button" data-action="close-modal" aria-label="Chiudi">×</button></div><form id="category-form" class="form-stack"><label>Nome categoria<input name="name" required placeholder="Es. Viaggi" /></label><label>Tipo<select name="type"><option value="entrambi">Entrate e uscite</option><option value="entrata">Solo entrate</option><option value="uscita">Solo uscite</option></select></label><p class="muted-small">La categoria sarà disponibile nei tuoi budget e visibile all’amministratore nel monitoraggio.</p><div class="modal-actions"><button type="button" class="button button-soft" data-action="close-modal">Annulla</button><button type="submit" class="button button-primary">Crea categoria <span>→</span></button></div></form></section></div>';
}

function paymentMethodKindOptions(selected = 'altro') {
  return Object.entries(paymentMethodKindLabels).filter(([kind]) => kind !== 'non_specificato').map(([kind, label]) => `<option value="${kind}" ${kind === selected ? 'selected' : ''}>${label}</option>`).join('');
}

function openPaymentMethodModal(method = null, options = {}) {
  const fromMovement = Boolean(options.fromMovement || pendingMovementDraft);
  const budget = getBudget(options.budgetId || method?.budgetId || pendingMovementDraft?.budgetId || state.selectedBudgetId);
  const isEditing = Boolean(method);
  if (!budget || !can(isEditing ? 'add' : 'add', budget.id)) return showToast('Per gestire i metodi devi poter inserire movimenti in questo budget.', 'error');
  if (isEditing && !canManagePaymentMethod(method)) return showToast('Puoi modificare solo i metodi creati da te.', 'error');
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" data-stop-propagation data-return-to-movement="${fromMovement ? 'true' : 'false'}"><div class="modal-header"><div><span class="section-kicker">Organizza</span><h2>${isEditing ? 'Modifica metodo o conto' : 'Nuovo metodo o conto'}</h2></div><button class="icon-button" data-action="close-modal" aria-label="Chiudi">×</button></div><form id="payment-method-form" class="form-stack"><input type="hidden" name="id" value="${method?.id || ''}" /><input type="hidden" name="budgetId" value="${budget.id}" /><label>Nome<input name="name" required maxlength="80" value="${escapeHtml(method?.name || '')}" placeholder="Es. Carta Visa, Contanti, PayPal" /></label><label>Tipo<select name="kind">${paymentMethodKindOptions(method?.kind || 'altro')}</select></label><div class="form-grid"><label>Saldo iniziale<input name="initialBalance" type="number" step="0.01" value="${method?.initialBalance ?? 0}" /></label><label>Data saldo iniziale<input name="openingDate" type="date" value="${method?.openingDate || APP_TODAY}" required /></label></div><p class="muted-small">Il saldo iniziale è il punto di partenza: da quella data MyBudget aggiunge le entrate effettive e sottrae le uscite.</p><div class="modal-actions"><button type="button" class="button button-soft" data-action="close-modal">Annulla</button><button type="submit" class="button button-primary">${isEditing ? 'Salva modifiche' : 'Crea metodo'} <span>→</span></button></div></form></section></div>`;
}

function openPaymentMethodArchiveModal(methodId) {
  const method = getPaymentMethod(methodId);
  if (!canManagePaymentMethod(method)) return showToast('Puoi archiviare solo i metodi creati da te.', 'error');
  const usage = paymentMethodTransactions(method.budgetId, method.id).filter((transaction) => !transaction.isProjected).length;
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal danger-modal" role="dialog" aria-modal="true" data-stop-propagation><div class="modal-header"><div><span class="section-kicker">Attenzione</span><h2>Archivia metodo o conto</h2></div><button class="icon-button" data-action="close-modal" aria-label="Chiudi">×</button></div><p class="modal-intro">Il metodo non sarà più proposto nei nuovi movimenti, ma i movimenti già registrati conserveranno il collegamento e resteranno nei report.</p><div class="delete-stats category-delete-stats"><div><strong>${usage}</strong><span>movimenti conservati</span></div><div><strong>0</strong><span>dati eliminati</span></div></div><form id="payment-method-archive-form" class="form-stack"><input type="hidden" name="id" value="${method.id}" /><label class="check-label"><input name="confirm" type="checkbox" required /> Ho letto le conseguenze di questa operazione</label><label>Per confermare, scrivi <strong>${escapeHtml(method.name)}</strong><input name="confirmation" required autocomplete="off" placeholder="Nome del metodo o conto" /></label><div class="modal-actions"><button type="button" class="button button-soft" data-action="close-modal">Annulla</button><button type="submit" class="button button-danger">Archivia</button></div></form></section></div>`;
}

function openCategoryEditModal(categoryId) {
  const category = getCategory(categoryId);
  if (!canManageCategory(category)) return showToast('Puoi modificare solo le categorie personali create da te.', 'error');
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" data-stop-propagation><div class="modal-header"><div><span class="section-kicker">Personalizza</span><h2>Modifica categoria</h2></div><button class="icon-button" data-action="close-modal" aria-label="Chiudi">×</button></div><form id="category-edit-form" class="form-stack"><input type="hidden" name="id" value="${category.id}" /><label>Nome categoria<input name="name" required maxlength="80" value="${escapeHtml(category.name)}" /></label><label>Tipo<select name="type"><option value="entrambi" ${category.type === 'entrambi' ? 'selected' : ''}>Entrate e uscite</option><option value="entrata" ${category.type === 'entrata' ? 'selected' : ''}>Solo entrate</option><option value="uscita" ${category.type === 'uscita' ? 'selected' : ''}>Solo uscite</option></select></label>${remoteMode && attachmentsFeatureAvailable ? '<label class="switch-line"><span><strong>Consenti allegati</strong><small>Permette di aggiungere foto ai movimenti di questa categoria</small></span><input name="allowAttachments" type="checkbox" ' + (category.allowAttachments ? 'checked' : '') + ' /><i></i></label>' : ''}<p class="muted-small">La modifica aggiorna il nome della categoria anche nei movimenti già registrati.</p><div class="modal-actions"><button type="button" class="button button-soft" data-action="close-modal">Annulla</button><button type="submit" class="button button-primary">Salva modifiche <span>→</span></button></div></form></section></div>`;
}

function openCategoryArchiveModal(categoryId) {
  const category = getCategory(categoryId);
  if (!canManageCategory(category)) return showToast('Puoi archiviare solo le categorie personali create da te.', 'error');
  const usage = state.transactions.filter((transaction) => transaction.categoryId === category.id).length;
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal danger-modal" role="dialog" aria-modal="true" data-stop-propagation><div class="modal-header"><div><span class="section-kicker">Attenzione</span><h2>Archivia categoria</h2></div><button class="icon-button" data-action="close-modal" aria-label="Chiudi">×</button></div><p class="modal-intro">La categoria non sarà più proposta per i nuovi movimenti, ma i dati storici resteranno intatti.</p><div class="delete-stats category-delete-stats"><div><strong>${usage}</strong><span>movimenti conservati</span></div><div><strong>0</strong><span>dati eliminati</span></div></div><form id="category-archive-form" class="form-stack"><input type="hidden" name="id" value="${category.id}" /><label class="check-label"><input name="confirm" type="checkbox" required /> Ho letto le conseguenze di questa operazione</label><label>Per confermare, scrivi <strong>${escapeHtml(category.name)}</strong><input name="confirmation" required autocomplete="off" placeholder="Nome della categoria" /></label><div class="modal-actions"><button type="button" class="button button-soft" data-action="close-modal">Annulla</button><button type="submit" class="button button-danger">Archivia categoria</button></div></form></section></div>`;
}

async function openCategoryDeleteModal(categoryId) {
  const category = getCategory(categoryId);
  if (!canManageCategory(category)) return showToast('Puoi eliminare solo le categorie personali create da te.', 'error');
  let counts = {
    transactions: state.transactions.filter((transaction) => transaction.categoryId === category.id).length,
    recurring: state.recurringTransactions.filter((transaction) => transaction.categoryId === category.id).length,
  };
  if (remoteMode) {
    const { data, error } = await supabase.rpc('category_delete_preview', { p_category_id: category.id });
    if (error) return showToast(`Impossibile verificare la categoria: ${error.message}`, 'error');
    counts = { transactions: Number(data?.transactions || 0), recurring: Number(data?.recurring_transactions || 0) };
  }
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal danger-modal" role="dialog" aria-modal="true" data-stop-propagation><div class="modal-header"><div><span class="section-kicker">Attenzione</span><h2>Elimina categoria</h2></div><button class="icon-button" data-action="close-modal" aria-label="Chiudi">×</button></div><p class="modal-intro">La categoria verrà eliminata definitivamente insieme a tutti i movimenti associati, anche quelli ricorrenti. Questa operazione non può essere annullata senza un backup.</p><div class="delete-stats category-delete-stats"><div><strong>${counts.transactions}</strong><span>movimenti eliminati</span></div><div><strong>${counts.recurring}</strong><span>ricorrenze eliminate</span></div></div><form id="category-delete-form" class="form-stack"><input type="hidden" name="id" value="${category.id}" /><label class="check-label"><input name="confirm" type="checkbox" required /> Ho letto le conseguenze e voglio eliminare i dati</label><label>Per confermare, scrivi <strong>${escapeHtml(category.name)}</strong><input name="confirmation" required autocomplete="off" placeholder="Nome della categoria" /></label><div class="modal-actions"><button type="button" class="button button-soft" data-action="close-modal">Annulla</button><button type="submit" class="button button-danger">Elimina categoria</button></div></form></section></div>`;
}

async function materializeProjectedTransaction(transaction) {
  if (!canManageProjectedOccurrence(transaction)) return showToast('Non hai i permessi per registrare questa occorrenza.', 'error');
  const payload = {
    transaction_date: transaction.date,
    amount: transaction.amount,
    type: transaction.type,
    category_id: transaction.categoryId,
    payment_method_id: transaction.paymentMethodId || null,
    description: transaction.description,
    budget_id: transaction.budgetId,
    recurring_transaction_id: transaction.recurringTransactionId,
    is_received: true,
  };
  if (remoteMode) {
    const { error } = await supabase.from('transactions').insert({ ...payload, author_id: state.sessionUserId });
    if (error) return showToast(error.message.includes('duplicate') ? 'Questa occorrenza è già stata registrata.' : error.message, 'error');
    await loadRemoteState(authUser);
  } else {
    state.transactions.unshift({ id: 'tx-' + Date.now(), date: transaction.date, amount: transaction.amount, type: transaction.type, categoryId: transaction.categoryId, paymentMethodId: transaction.paymentMethodId, description: transaction.description, budgetId: transaction.budgetId, authorId: state.sessionUserId, isReceived: true, recurringTransactionId: transaction.recurringTransactionId, recurring: true, isProjected: false });
    persist();
    refreshSummary();
  }
  render();
  showToast(transaction.type === 'entrata' ? 'Entrata segnata come incassata.' : 'Uscita segnata come pagata.');
}

async function skipProjectedTransaction(transaction) {
  if (!canManageProjectedOccurrence(transaction)) return showToast('Non hai i permessi per saltare questa occorrenza.', 'error');
  if (remoteMode) {
    const { error } = await supabase.from('recurring_transaction_exceptions').insert({ recurring_transaction_id: transaction.recurringTransactionId, occurrence_date: transaction.date, created_by: state.sessionUserId });
    if (error) return showToast(error.message.includes('duplicate') ? 'Questa occorrenza è già stata saltata.' : error.message, 'error');
    await loadRemoteState(authUser);
  } else {
    state.recurringExceptions.push({ id: 'exception-' + Date.now(), recurringTransactionId: transaction.recurringTransactionId, date: transaction.date, createdBy: state.sessionUserId });
    persist();
    refreshSummary();
  }
  document.querySelector('#modal-root').innerHTML = '';
  render();
  showToast('Occorrenza eliminata. La ricorrenza continua sulle date successive.');
}

function openTransactionDeleteModal(transactionId) {
  const transaction = findTransactionById(transactionId);
  const canDelete = canDeleteTransaction(transaction) || canManageProjectedOccurrence(transaction);
  if (!canDelete) return showToast('Puoi eliminare solo i tuoi movimenti o le occorrenze dei budget in cui puoi inserire dati.', 'error');
  const category = getCategory(transaction.categoryId);
  const recurringNote = transaction.isProjected
    ? ' Verrà saltata solo questa occorrenza prevista: la ricorrenza continuerà sulle date successive.'
    : transaction.recurring
      ? ' Verrà eliminata solo questa occorrenza già registrata: la ricorrenza continuerà sulle date successive.'
      : '';
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal danger-modal" role="dialog" aria-modal="true" data-stop-propagation><div class="modal-header"><div><span class="section-kicker">Attenzione</span><h2>${transaction.isProjected ? 'Salta occorrenza prevista' : 'Elimina movimento'}</h2></div><button class="icon-button" data-action="close-modal" aria-label="Chiudi">×</button></div><p class="modal-intro">Stai per ${transaction.isProjected ? 'saltare' : 'eliminare'} questo movimento.${recurringNote} L’operazione non può essere annullata senza un backup.</p><div class="delete-stats category-delete-stats"><div><strong>${euro(transaction.amount)}</strong><span>${transaction.type === 'entrata' ? 'entrata' : 'uscita'}</span></div><div><strong>${escapeHtml(category?.name || 'Senza categoria')}</strong><span>${date(transaction.date)}</span></div></div><form id="transaction-delete-form" class="form-stack"><input type="hidden" name="id" value="${transaction.id}" /><label class="check-label"><input name="confirm" type="checkbox" required /> Ho letto le conseguenze e confermo l’operazione</label><div class="modal-actions"><button type="button" class="button button-soft" data-action="close-modal">Annulla</button><button type="submit" class="button button-danger">${transaction.isProjected ? 'Salta occorrenza' : 'Elimina movimento'}</button></div></form></section></div>`;
}

const normalizeName = (value) => String(value ?? '').trim().toLocaleLowerCase('it-IT');
const categoriesForBudget = (budgetId) => state.categories.filter((category) => !category.archived && (category.default || category.ownerId === state.sessionUserId || state.budgetCategories.some((item) => item.budgetId === budgetId && item.categoryId === category.id && item.enabled)));
const canManageCategory = (category) => Boolean(category && !category.default && category.ownerId === state.sessionUserId);
const categoryTransactionsFor = (budgetId, categoryId, view, month) => transactionsForBudget(budgetId).filter((transaction) => transaction.categoryId === categoryId && (view === 'year' ? transaction.date.startsWith(`${APP_YEAR}-`) : transaction.date.startsWith(month)));

function validateImportRows(parsed) {
  const errors = [...(parsed.errors || [])];
  const rows = [];
  const duplicates = [];
  const signatures = new Set();
  const storedSignatures = new Set(state.transactions.map((transaction) => `${transaction.budgetId}|${transaction.date}|${transaction.type}|${transaction.amount}|${transaction.categoryId}|${transactionPaymentMethodId(transaction)}|${normalizeName(transaction.description)}|${transaction.isReceived === true}`));
  if (!parsed.rows.length && !errors.length) errors.push({ row: null, message: 'Il foglio non contiene movimenti compilati.' });

  parsed.rows.forEach((row) => {
    const rowErrors = [];
    const rowLabel = `Riga ${row.sourceRow}`;
    const budgetMatches = state.budgets.filter((budget) => normalizeName(budget.name) === normalizeName(row.budget));
    const budget = budgetMatches.length === 1 ? budgetMatches[0] : null;
    if (!row.budget) rowErrors.push('budget mancante');
    else if (!budgetMatches.length) rowErrors.push(`budget "${row.budget}" non trovato nel tuo account`);
    else if (budgetMatches.length > 1) rowErrors.push(`budget "${row.budget}" non univoco`);
    else if (!can('add', budget.id)) rowErrors.push(`non hai il permesso di inserire movimenti nel budget "${budget.name}"`);

    if (!isValidIsoDate(row.date)) rowErrors.push('data non valida: usa YYYY-MM-DD');
    if (!['entrata', 'uscita'].includes(row.type)) rowErrors.push('tipo non valido: usa entrata oppure uscita');
    if (!Number.isFinite(row.amount) || row.amount <= 0) rowErrors.push('importo non valido: inserisci un numero positivo');
    if (!row.category) rowErrors.push('categoria mancante');
    if (!row.description) rowErrors.push('descrizione mancante');

    const categoryMatches = budget ? categoriesForBudget(budget.id).filter((category) => normalizeName(category.name) === normalizeName(row.category)) : [];
    const category = categoryMatches.length === 1 ? categoryMatches[0] : null;
    if (row.category && !categoryMatches.length) rowErrors.push(`categoria "${row.category}" non trovata nel budget`);
    else if (categoryMatches.length > 1) rowErrors.push(`categoria "${row.category}" non univoca`);
    else if (category && category.type !== 'entrambi' && category.type !== row.type) rowErrors.push(`la categoria "${category.name}" non è compatibile con ${row.type}`);

    const paymentMethodMatches = budget ? paymentMethodsForBudget(budget.id).filter((method) => normalizeName(method.name) === normalizeName(row.paymentMethod || 'Non specificato')) : [];
    const paymentMethod = paymentMethodMatches.length === 1 ? paymentMethodMatches[0] : null;
    if (paymentMethodMatches.length > 1) rowErrors.push(`metodo/conto "${row.paymentMethod}" non univoco`);
    else if (!paymentMethodMatches.length) rowErrors.push(`metodo/conto "${row.paymentMethod || 'Non specificato'}" non trovato nel budget`);
    else if (paymentMethod.archived) rowErrors.push(`il metodo/conto "${paymentMethod.name}" è archiviato`);

    if (row.type === 'entrata') {
      if (row.received === null) rowErrors.push('incassata mancante: usa SI oppure NO');
      if (row.received === undefined) rowErrors.push('incassata non valida: usa SI oppure NO');
    }
    if (row.recurring === undefined) rowErrors.push('ricorrente non valida: usa NO');
    if (row.recurring === true) rowErrors.push('le ricorrenze non sono ancora supportate nell’import massivo: imposta ricorrente = NO');

    const signature = budget && category && paymentMethod && `${budget.id}|${row.date}|${row.type}|${row.amount}|${category.id}|${paymentMethod.id}|${normalizeName(row.description)}|${row.received === true}`;
    const duplicateInFile = Boolean(signature && signatures.has(signature));
    const duplicateInDatabase = Boolean(signature && storedSignatures.has(signature));
    const duplicate = duplicateInFile || duplicateInDatabase;
    if (signature) signatures.add(signature);

    if (rowErrors.length) errors.push({ row: row.sourceRow, message: rowErrors.join('; ') });
    else {
      const normalized = { ...row, budgetId: budget.id, categoryId: category.id, paymentMethodId: paymentMethod.id, isReceived: row.type === 'entrata' ? row.received : true, duplicate, duplicateReason: duplicateInFile ? 'Già presente nella stessa importazione' : 'Possibile movimento già presente nel budget' };
      rows.push(normalized);
      if (duplicate) duplicates.push({ row: row.sourceRow, message: normalized.duplicateReason });
    }
  });
  return { rows, errors, duplicates };
}

const importErrorText = (error) => `${error.row ? `Riga ${error.row}: ` : ''}${error.message}`;
const syncImportCommitLabel = () => {
  const confirm = document.querySelector('[data-action="confirm-import"]');
  if (!confirm || !importDraft?.rows?.length) return;
  const excludeAll = document.querySelector('[data-import-exclude-all]')?.checked;
  const excluded = new Set([...document.querySelectorAll('[data-import-exclude]:checked')].map((input) => Number(input.dataset.importExclude)));
  const count = importDraft.rows.filter((row) => !(row.duplicate && (excludeAll || excluded.has(row.sourceRow)))).length;
  confirm.textContent = `Importa ${count} ${count === 1 ? 'movimento' : 'movimenti'}`;
  confirm.disabled = count === 0;
};

function renderImportPreview(result) {
  const preview = document.querySelector('#import-preview');
  const confirm = document.querySelector('[data-action="confirm-import"]');
  if (!preview || !confirm) return;
  if (result.errors.length) {
    importDraft = null;
    confirm.disabled = true;
    confirm.textContent = 'Importa movimenti';
    preview.innerHTML = `<div class="import-result import-result-error"><strong>Controllo non superato</strong><p>Nessun movimento è stato salvato. Correggi il file e riprova.</p><ul>${result.errors.slice(0, 20).map((error) => `<li>${escapeHtml(importErrorText(error))}</li>`).join('')}</ul>${result.errors.length > 20 ? `<small>... e altri ${result.errors.length - 20} errori.</small>` : ''}</div>`;
    return;
  }
  importDraft = { fileName: result.fileName, rows: result.rows, duplicates: result.duplicates || [] };
  confirm.disabled = false;
  confirm.textContent = `Importa ${result.rows.length} movimenti`;
  const sample = result.rows.slice(0, 6);
  const duplicateRows = result.rows.filter((row) => row.duplicate);
  const duplicateAlert = duplicateRows.length ? `<div class="import-duplicate-alert"><strong>Attenzione: ${duplicateRows.length} ${duplicateRows.length === 1 ? 'riga sembra' : 'righe sembrano'} duplicata/e</strong><p>La segnalazione è solo informativa: due movimenti uguali nello stesso giorno possono essere corretti, come due pedaggi. Per impostazione predefinita verranno importati tutti.</p><div class="duplicate-actions"><label class="check-label"><input type="checkbox" data-import-exclude-all /> Escludi tutte le righe segnalate</label><span class="muted-small">Puoi anche escluderle singolarmente qui sotto.</span></div><div class="duplicate-list">${duplicateRows.map((row) => `<label class="duplicate-row"><input type="checkbox" data-import-exclude="${row.sourceRow}" /><span><strong>Riga ${row.sourceRow}</strong><small>${escapeHtml(row.date)} · ${euro(row.amount)} · ${escapeHtml(row.description)}</small></span></label>`).join('')}</div></div>` : '';
  preview.innerHTML = `<div class="import-result import-result-success"><strong>File pronto</strong><p>${result.rows.length} ${result.rows.length === 1 ? 'movimento valido' : 'movimenti validi'}. Il salvataggio avverrà in un’unica operazione.</p>${duplicateAlert}<div class="import-table-wrap"><table class="import-table"><thead><tr><th>Riga</th><th>Data</th><th>Tipo</th><th>Importo</th><th>Budget</th><th>Categoria</th><th>Metodo/conto</th><th>Stato</th></tr></thead><tbody>${sample.map((row) => `<tr class="${row.duplicate ? 'is-duplicate' : ''}"><td>${row.sourceRow}</td><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.type)}</td><td>${euro(row.amount)}</td><td>${escapeHtml(state.budgets.find((budget) => budget.id === row.budgetId)?.name)}</td><td>${escapeHtml(state.categories.find((category) => category.id === row.categoryId)?.name)}</td><td>${escapeHtml(getPaymentMethod(row.paymentMethodId)?.name || 'Non specificato')}</td><td>${row.duplicate ? 'Possibile duplicato' : row.type === 'entrata' && !row.isReceived ? 'Prevista' : row.type === 'entrata' ? 'Incassata' : 'Uscita'}</td></tr>`).join('')}</tbody></table></div>${result.rows.length > sample.length ? `<small>Anteprima delle prime ${sample.length} righe.</small>` : ''}</div>`;
}

function openImportModal() {
  if (!can('add')) return showToast('Non hai i permessi per importare movimenti in questo budget.', 'error');
  importDraft = null;
  document.querySelector('#modal-root').innerHTML = '<div class="modal-backdrop" data-action="close-modal"><section class="modal import-modal" role="dialog" aria-modal="true" aria-labelledby="import-modal-title" data-stop-propagation><div class="modal-header"><div><span class="section-kicker">Caricamento massivo</span><h2 id="import-modal-title">Importa da Excel</h2></div><button class="icon-button" data-action="close-modal" aria-label="Chiudi">×</button></div><p class="import-intro">Usa il file standard MyBudget con le intestazioni originali. La colonna metodo_conto è facoltativa: se resta vuota il movimento usa “Non specificato”. Il sistema controlla tutte le righe prima di salvare e non usa interpretazioni automatiche. <a href="/template-import-movimenti.xlsx" download>Scarica il modello aggiornato</a>.</p><label class="file-picker"><span class="file-picker-icon">⇧</span><span><strong>Scegli un file Excel</strong><small> .xlsx, .xls o .csv · il foglio deve chiamarsi Import movimenti</small></span><input data-import-file type="file" accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" /></label><p class="selected-file" data-import-file-name>Nessun file selezionato</p><div id="import-preview" class="import-preview"><div class="import-empty"><span>☷</span><strong>Prima verifica il file</strong><p>Le categorie, il budget e gli eventuali metodi devono già esistere nel tuo account.</p></div></div><div class="modal-actions"><button type="button" class="button button-soft" data-action="close-modal">Annulla</button><button type="button" class="button button-soft" data-action="inspect-import">Verifica file</button><button type="button" class="button button-primary" data-action="confirm-import" disabled>Importa movimenti</button></div></section></div>';
}

async function prepareImportPreview() {
  const input = document.querySelector('[data-import-file]');
  const file = input?.files?.[0];
  if (!file) return showToast('Seleziona prima il file Excel da importare.', 'info');
  const preview = document.querySelector('#import-preview');
  if (preview) preview.innerHTML = '<div class="import-loading">Controllo tutte le righe del file...</div>';
  try {
    const parsed = await parseMovementWorkbook(file);
    const validated = validateImportRows(parsed);
    renderImportPreview({ ...validated, fileName: parsed.fileName });
  } catch (error) {
    importDraft = null;
    if (preview) preview.innerHTML = `<div class="import-result import-result-error"><strong>File non leggibile</strong><p>${escapeHtml(error.message || 'Si è verificato un errore durante la lettura del file.')}</p></div>`;
    const confirm = document.querySelector('[data-action="confirm-import"]');
    if (confirm) confirm.disabled = true;
  }
}

async function commitImport() {
  if (!importDraft?.rows?.length) return showToast('Verifica prima un file valido.', 'info');
  const excluded = new Set([...document.querySelectorAll('[data-import-exclude]:checked')].map((input) => Number(input.dataset.importExclude)));
  const excludeAll = document.querySelector('[data-import-exclude-all]')?.checked;
  const rows = importDraft.rows.filter((row) => !(row.duplicate && (excludeAll || excluded.has(row.sourceRow))));
  if (!rows.length) return showToast('Non ci sono movimenti da importare dopo le esclusioni selezionate.', 'info');
  const payload = rows.map((row) => ({ transaction_date: row.date, amount: row.amount, type: row.type, category_id: row.categoryId, payment_method_id: row.paymentMethodId, description: row.description, budget_id: row.budgetId, author_id: state.sessionUserId, is_received: row.isReceived }));
  if (remoteMode) {
    const { error } = await supabase.from('transactions').insert(payload);
    if (error) return showToast(error.message, 'error');
    await loadRemoteState(authUser);
  } else {
    const stamp = Date.now();
    state.transactions = [...rows.map((row, index) => ({ id: `tx-import-${stamp}-${index}`, date: row.date, amount: row.amount, type: row.type, categoryId: row.categoryId, paymentMethodId: row.paymentMethodId, description: row.description, budgetId: row.budgetId, authorId: state.sessionUserId, isReceived: row.isReceived, recurringTransactionId: null, recurring: false })), ...state.transactions];
    refreshSummary();
    persist();
  }
  importDraft = null;
  document.querySelector('#modal-root').innerHTML = '';
  render();
  showToast(`${rows.length} ${rows.length === 1 ? 'movimento importato' : 'movimenti importati'} con successo.`);
}

function openTransactionModal(transaction = null, options = {}) {
  const draft = options.draft || null;
  const formState = draft || transaction;
  const isEditing = Boolean(transaction);
  const isProjectedOccurrence = Boolean(transaction?.isProjected);
  const budget = getBudget(formState?.budgetId || state.selectedBudgetId);
  if (!budget || !(isProjectedOccurrence ? can('add', budget.id) : can(isEditing ? 'edit' : 'add', budget.id))) return showToast('Non hai i permessi per questa operazione.', 'error');
  const recurringItem = selectedRecurring(transaction);
  const recurringEnabled = Boolean(formState?.recurring || recurringItem);
  const recurringFrequency = recurringItem?.frequency || 'mensile';
  const recurringDay = recurringItem?.day || formState?.day || 1;
  const recurringStartDate = formState?.date || APP_TODAY;
  const recurringEndDate = recurringItem?.endDate || formState?.endDate || maxRecurringEndDate(recurringStartDate);
  const categories = state.categories.filter((category) => !category.archived && (category.default || category.ownerId === state.sessionUserId || state.budgetCategories.some((item) => item.budgetId === budget.id && item.categoryId === category.id && item.enabled)));
  const selectedCategoryId = options.selectedCategoryId || formState?.categoryId;
  const attachmentsAllowed = Boolean(remoteMode && attachmentsFeatureAvailable && categories.find((category) => category.id === selectedCategoryId)?.allowAttachments);
  const paymentMethods = paymentMethodsForBudget(budget.id);
  const selectedPaymentMethodId = options.selectedPaymentMethodId || formState?.paymentMethodId || defaultPaymentMethodForBudget(budget.id)?.id || '';
  const projectedHint = isProjectedOccurrence ? '<p class="modal-intro">La modifica riguarda solo questa occorrenza. La ricorrenza resterà invariata per le date successive.</p>' : '';
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" data-stop-propagation><div class="modal-header"><div><span class="section-kicker">${isEditing ? 'Modifica' : 'Nuovo'}</span><h2 id="modal-title">${isEditing ? 'Modifica movimento' : 'Nuovo movimento'}</h2></div><button class="icon-button" data-action="close-modal" aria-label="Chiudi">×</button></div>${projectedHint}<form id="transaction-form" class="form-stack"><input type="hidden" name="id" value="${formState?.id || ''}" />${isProjectedOccurrence ? `<input type="hidden" name="projectedDate" value="${formState?.date || ''}" /><input type="hidden" name="projectedBudgetId" value="${formState?.budgetId || budget.id}" />` : ''}<div class="form-grid"><label>Tipo<div class="segmented-control"><label><input type="radio" name="type" value="uscita" ${!formState || formState.type === 'uscita' ? 'checked' : ''} /><span>Uscita</span></label><label><input type="radio" name="type" value="entrata" ${formState?.type === 'entrata' ? 'checked' : ''} /><span>Entrata</span></label></div></label><label>Importo<input name="amount" type="number" min="0.01" step="0.01" placeholder="0,00" value="${formState?.amount || ''}" required /></label></div><div class="form-grid"><label>Data<input name="date" type="date" value="${formState?.date || APP_TODAY}" required ${isProjectedOccurrence ? 'disabled' : ''} /></label><label>Budget<select name="budgetId" ${isProjectedOccurrence ? 'disabled' : ''}>${state.budgets.map((item) => `<option value="${item.id}" ${item.id === (formState?.budgetId || budget.id) ? 'selected' : ''}>${item.name}</option>`).join('')}</select></label></div><div class="form-grid"><label>Categoria<select name="categoryId" required><option value="" disabled ${selectedCategoryId ? '' : 'selected'}>— Seleziona una categoria —</option>${categories.map((category) => `<option value="${category.id}" ${category.id === selectedCategoryId ? 'selected' : ''}>${category.icon} ${category.name}</option>`).join('')}<option value="new">＋ Crea categoria</option></select></label><label>Metodo / conto<select name="paymentMethodId" required><option value="" disabled ${selectedPaymentMethodId ? '' : 'selected'}>— Seleziona un metodo —</option>${paymentMethods.map((method) => `<option value="${method.id}" ${method.id === selectedPaymentMethodId ? 'selected' : ''}>${escapeHtml(method.name)}</option>`).join('')}<option value="new">＋ Crea metodo o conto</option></select></label></div><label>Descrizione<input name="description" placeholder="Es. Spesa settimanale" value="${formState?.description || ''}" required /></label><section class="attachment-upload-field ${attachmentsAllowed ? '' : 'hidden'}" data-attachment-upload><div><strong>Foto dello scontrino o della fattura</strong><small>Le immagini vengono compresse prima del caricamento. Massimo ${MAX_TRANSACTION_ATTACHMENTS} foto.</small></div><label class="attachment-file-picker"><span>📷 Scegli o scatta foto</span><input name="attachments" type="file" accept="image/*" capture="environment" multiple ${isProjectedOccurrence ? 'disabled' : ''} /></label><p class="attachment-selection" data-attachment-selection>Nessuna foto selezionata</p></section><label class="switch-line"><span><strong>Movimento ricorrente</strong><small>Genera automaticamente le prossime occorrenze</small></span><input name="recurring" type="checkbox" ${recurringEnabled ? 'checked' : ''} /><i></i></label><div class="recurring-fields ${recurringEnabled ? '' : 'hidden'}"><div class="form-grid"><label>Frequenza<select name="frequency"><option value="mensile" ${recurringFrequency === 'mensile' ? 'selected' : ''}>Mensile</option><option value="annuale" ${recurringFrequency === 'annuale' ? 'selected' : ''}>Annuale</option></select></label><label>Giorno<input name="day" type="number" min="1" max="31" value="${recurringDay}" /></label><label>Data fine (massimo 12 mesi)<input name="endDate" type="date" min="${recurringStartDate}" max="${maxRecurringEndDate(recurringStartDate)}" value="${recurringEndDate}" /><small class="field-hint">La durata massima è di 12 mesi dalla data di inizio.</small><span class="field-error hidden" data-recurring-end-error>La data fine deve rientrare nei 12 mesi dalla data di inizio.</span></label></div></div><div class="modal-actions"><button type="button" class="button button-soft" data-action="close-modal">Annulla</button><button type="button" data-action="submit-transaction" class="button button-primary">${isEditing ? 'Salva modifiche' : 'Aggiungi movimento'} <span>→</span></button></div></form></section></div>`;
  const incomeReceived = formState?.type === 'entrata' && formState.isReceived !== false;
  const descriptionField = document.querySelector('.modal input[name="description"]')?.closest('label');
  descriptionField?.insertAdjacentHTML('afterend', '<label class="switch-line income-status-field ' + (formState?.type === 'entrata' ? '' : 'hidden') + '"><span><strong>Incassata</strong><small>Seleziona quando il bonifico è arrivato</small></span><input name="isReceived" type="checkbox" ' + (incomeReceived ? 'checked' : '') + ' /><i></i></label>');
  const transactionForm = document.querySelector('#transaction-form');
  const attachmentCategoryInput = transactionForm?.querySelector('select[name="categoryId"]');
  const attachmentUploadField = transactionForm?.querySelector('[data-attachment-upload]');
  const attachmentInput = transactionForm?.querySelector('input[name="attachments"]');
  const attachmentSelection = transactionForm?.querySelector('[data-attachment-selection]');
  const syncAttachmentField = () => {
    const allowed = Boolean(remoteMode && attachmentsFeatureAvailable && getCategory(attachmentCategoryInput?.value)?.allowAttachments);
    attachmentUploadField?.classList.toggle('hidden', !allowed);
    if (!allowed && attachmentInput) {
      attachmentInput.value = '';
      if (attachmentSelection) attachmentSelection.textContent = 'Nessuna foto selezionata';
    }
  };
  attachmentCategoryInput?.addEventListener('change', syncAttachmentField);
  attachmentInput?.addEventListener('change', () => {
    const files = [...(attachmentInput.files || [])];
    if (files.length > MAX_TRANSACTION_ATTACHMENTS) {
      attachmentInput.value = '';
      if (attachmentSelection) attachmentSelection.textContent = `Puoi selezionare al massimo ${MAX_TRANSACTION_ATTACHMENTS} foto.`;
      return;
    }
    if (attachmentSelection) attachmentSelection.textContent = files.length ? `${files.length} ${files.length === 1 ? 'foto selezionata' : 'foto selezionate'}` : 'Nessuna foto selezionata';
  });
  const recurringInput = transactionForm?.querySelector('input[name="recurring"]');
  const syncRecurringFields = () => transactionForm?.querySelector('.recurring-fields')?.classList.toggle('hidden', !recurringInput?.checked);
  const startDateInput = transactionForm?.querySelector('input[name="date"]');
  const endDateInput = transactionForm?.querySelector('input[name="endDate"]');
  const endDateError = transactionForm?.querySelector('[data-recurring-end-error]');
  const syncEndDateLimit = () => {
    const startDate = startDateInput?.value || APP_TODAY;
    const maxDate = maxRecurringEndDate(startDate);
    if (endDateInput) {
      endDateInput.min = startDate;
      endDateInput.max = maxDate;
    }
    const invalid = Boolean(endDateInput?.value && endDateInput.value > maxDate);
    endDateError?.classList.toggle('hidden', !invalid);
    if (endDateInput) endDateInput.setCustomValidity(invalid ? 'La data fine deve rientrare nei 12 mesi dalla data di inizio.' : '');
    return !invalid;
  };
  startDateInput?.addEventListener('change', syncEndDateLimit);
  endDateInput?.addEventListener('input', syncEndDateLimit);
  recurringInput?.addEventListener('change', syncRecurringFields);
  const submitButton = transactionForm?.querySelector('[data-action="submit-transaction"]');
  submitButton?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    handleSubmit({ target: transactionForm, preventDefault() {} }).catch((error) => showToast(error.message, 'error'));
  });
  transactionForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    event.stopPropagation();
    handleSubmit(event).catch((error) => showToast(error.message, 'error'));
  });
  syncRecurringFields();
  syncEndDateLimit();
}

async function handleSubmit(event) {
  const formElement = event.target.closest?.('form') || event.target;
  const formId = formElement.getAttribute?.('id') || '';
  if (formId === 'login-form') {
    event.preventDefault();
    const form = new FormData(formElement);
    if (!remoteMode) {
      state.sessionUserId = 'user-leo';
      state.currentPage = 'dashboard';
      persist();
      render();
      showToast('Accesso effettuato. Benvenuto in MyBudget!');
      return;
    }
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');
    isLoading = true;
    render();
    try {
      const { data, error } = await withTimeout(
        supabase.auth.signInWithPassword({ email, password }),
        15000,
        'Il servizio di accesso sta impiegando troppo tempo. Controlla la connessione e riprova.',
      );
      if (error) {
        const message = error.message === 'Invalid login credentials'
          ? 'Email o password non corrette.'
          : error.message === 'Email not confirmed'
            ? 'Conferma prima la tua email per poter accedere.'
            : error.message;
        isLoading = false;
        render();
        showToast(message, 'error');
        return;
      }
      if (!data?.session) throw new Error('Accesso non completato. Riprova tra qualche secondo.');
      await withTimeout(
        hydrateSession(data.session),
        20000,
        'Accesso riuscito, ma il caricamento dei dati sta impiegando troppo tempo. Riprova.',
      );
    } catch (error) {
      isLoading = false;
      render();
      showToast(error.message, 'error');
    }
    return;
  }
  if (formId === 'register-form') {
    event.preventDefault();
    if (!remoteMode) return showToast('La registrazione è disponibile quando colleghi Supabase.', 'info');
    const form = new FormData(formElement);
    const { data, error } = await supabase.auth.signUp({
      email: form.get('email'),
      password: form.get('password'),
      options: {
        emailRedirectTo: authRedirectUrl(),
        data: { first_name: form.get('firstName'), last_name: form.get('lastName') },
      },
    });
    if (error) return showToast(error.message, 'error');
    if (data.session) await hydrateSession(data.session);
    showToast('Richiesta inviata. Conferma la email: il link ti riporterà su MyBudget.');
    return;
  }
  if (formId === 'budget-form') {
    event.preventDefault();
    const form = new FormData(formElement);
    const name = String(form.get('name')).trim();
    if (!name) return;
    const color = form.get('color') || '#5e9b87';
    if (remoteMode) {
      const { data, error } = await supabase.from('budgets').insert({ name, color, created_by: state.sessionUserId }).select('id').single();
      if (error) return showToast(error.message, 'error');
      const { error: memberError } = await supabase.from('budget_members').insert({ budget_id: data.id, user_id: state.sessionUserId, can_view: true, can_add: true, can_edit: true, can_manage: true });
      if (memberError) return showToast(memberError.message, 'error');
      await loadRemoteState(authUser);
      state.selectedBudgetId = data.id;
    } else {
      const id = 'budget-' + Date.now();
      state.budgets.push({ id, name, color, createdBy: state.sessionUserId });
      state.budgetMembers.push({ budgetId: id, userId: state.sessionUserId, view: true, add: true, edit: true, manage: true });
      state.paymentMethods.push({ id: `pm-default-${id}`, budgetId: id, ownerId: state.sessionUserId, name: 'Non specificato', kind: 'non_specificato', initialBalance: 0, openingDate: APP_TODAY, default: true, archived: false, createdAt: new Date().toISOString() });
      state.selectedBudgetId = id;
      persist();
      refreshSummary();
    }
    document.querySelector('#modal-root').innerHTML = '';
    render();
    showToast('Budget creato.');
    return;
  }
  if (formId === 'share-budget-form') {
    event.preventDefault();
    const form = new FormData(formElement);
    const budgetId = String(form.get('budgetId') || '');
    const email = String(form.get('email') || '').trim().toLowerCase();
    const level = String(form.get('level') || 'view');
    const budget = getAnyBudget(budgetId);
    if (!budget || !isBudgetOwner(budget)) return showToast('Solo il proprietario può gestire la condivisione.', 'error');
    if (!email) return showToast('Inserisci l’email dell’utente da invitare.', 'error');
    if (remoteMode) {
      const { error } = await supabase.rpc('share_budget_with_email', { p_budget_id: budgetId, p_email: email, p_can_view: true, p_can_add: level !== 'view', p_can_edit: level === 'edit' });
      if (error) return showToast(error.message.includes('not found') ? 'Nessun utente attivo trovato con questa email.' : error.message, 'error');
      await loadRemoteState(authUser);
    } else {
      const profile = state.profiles.find((item) => String(item.email || '').toLowerCase() === email && item.status === 'attivo');
      if (!profile) return showToast('Nessun utente attivo trovato con questa email nella demo.', 'error');
      if (profile.id === state.sessionUserId) return showToast('Sei già il proprietario di questo budget.', 'info');
      const current = state.budgetMembers.find((item) => item.budgetId === budgetId && item.userId === profile.id);
      const permissions = { view: true, add: level !== 'view', edit: level === 'edit', manage: false };
      if (current) Object.assign(current, permissions);
      else state.budgetMembers.push({ budgetId, userId: profile.id, ...permissions });
      state.budgetAccess[budgetId] = budgetAccessFor(budgetId);
      persist();
    }
    document.querySelector('#modal-root').innerHTML = '';
    render();
    showToast('Budget condiviso con successo.');
    return;
  }
  if (formId === 'admin-budget-form') {
    event.preventDefault();
    if (getUser()?.role !== 'admin') return showToast('Solo l’amministratore può creare budget per un utente.', 'error');
    const form = new FormData(formElement);
    const userId = String(form.get('userId') || '');
    const name = String(form.get('name') || '').trim();
    const color = String(form.get('color') || '#5e9b87');
    if (!userId || !name) return showToast('Inserisci il nome del budget.', 'error');
    if (remoteMode) {
      const { error } = await supabase.rpc('admin_create_budget_for_user', { p_user_id: userId, p_name: name, p_color: color });
      if (error) return showToast(error.message, 'error');
      await loadRemoteState(authUser);
    } else {
      const id = 'budget-' + Date.now();
      state.budgets.push({ id, name, color, createdBy: userId, createdAt: new Date().toISOString(), archivedAt: null });
      state.budgetMembers.push({ budgetId: id, userId, view: true, add: true, edit: true, manage: true });
      state.paymentMethods.push({ id: `pm-default-${id}`, budgetId: id, ownerId: userId, name: 'Non specificato', kind: 'non_specificato', initialBalance: 0, openingDate: APP_TODAY, default: true, archived: false, createdAt: new Date().toISOString() });
      persist();
    }
    document.querySelector('#modal-root').innerHTML = '';
    render();
    showToast('Budget creato per l’utente.');
    return;
  }
  if (formId === 'budget-action-form') {
    event.preventDefault();
    const form = new FormData(formElement);
    const budgetId = String(form.get('budgetId') || '');
    const operation = String(form.get('operation') || '');
    const actor = String(form.get('actor') || 'owner');
    const budget = getAnyBudget(budgetId);
    const isAdminAction = actor === 'admin' && getUser()?.role === 'admin';
    if (!budget || (!isBudgetOwner(budget) && !isAdminAction)) return showToast('Non hai i permessi per eseguire questa operazione.', 'error');
    if (form.get('confirm') !== 'on' || String(form.get('confirmation') || '').trim() !== budget.name) return showToast('Seleziona la conferma e scrivi esattamente il nome del budget.', 'error');
    if (remoteMode) {
      const rpcName = isAdminAction
        ? (operation === 'archive' ? 'admin_archive_budget' : 'admin_delete_budget_safely')
        : (operation === 'archive' ? 'archive_budget' : 'delete_budget_safely');
      const { error } = await supabase.rpc(rpcName, { p_budget_id: budgetId });
      if (error) return showToast(error.message, 'error');
      await loadRemoteState(authUser);
    } else if (operation === 'archive') {
      state.budgets = state.budgets.filter((item) => item.id !== budgetId);
      state.archivedBudgets.push({ ...budget, archivedAt: new Date().toISOString() });
      if (state.selectedBudgetId === budgetId) state.selectedBudgetId = state.budgets[0]?.id;
      persist();
    } else {
      state.budgets = state.budgets.filter((item) => item.id !== budgetId);
      state.archivedBudgets = state.archivedBudgets.filter((item) => item.id !== budgetId);
      state.budgetMembers = state.budgetMembers.filter((item) => item.budgetId !== budgetId);
      state.budgetCategories = state.budgetCategories.filter((item) => item.budgetId !== budgetId);
      state.categoryLimits = state.categoryLimits.filter((item) => item.budgetId !== budgetId);
      state.paymentMethods = state.paymentMethods.filter((item) => item.budgetId !== budgetId);
      state.transactions = state.transactions.filter((item) => item.budgetId !== budgetId);
      state.recurringTransactions = state.recurringTransactions.filter((item) => item.budgetId !== budgetId);
      if (state.selectedBudgetId === budgetId) state.selectedBudgetId = state.budgets[0]?.id;
      persist();
    }
    document.querySelector('#modal-root').innerHTML = '';
    refreshSummary();
    render();
    showToast(operation === 'archive' ? 'Budget archiviato.' : 'Budget eliminato definitivamente.');
    return;
  }
  if (formId === 'transaction-form') {
    event.preventDefault();
    const form = new FormData(formElement);
    const id = form.get('id');
    const existingTransaction = id ? state.transactions.find((transaction) => transaction.id === id) : null;
    const projectedTransaction = id ? recurringOccurrences().find((transaction) => transaction.id === id) : null;
    const attachmentFiles = [...(formElement.querySelector('input[name="attachments"]')?.files || [])];
    const type = form.get('type');
    const recurringEnabled = form.get('recurring') === 'on';
    const frequency = form.get('frequency') || 'mensile';
    const day = Math.min(31, Math.max(1, Number(form.get('day')) || 1));
    const payload = {
      transaction_date: form.get('date') || form.get('projectedDate'),
      amount: Number(form.get('amount')),
      type,
      category_id: form.get('categoryId'),
      payment_method_id: form.get('paymentMethodId') || null,
      description: form.get('description'),
      budget_id: form.get('budgetId') || form.get('projectedBudgetId'),
      is_received: type === 'entrata' ? form.get('isReceived') === 'on' : true,
    };
    if (!payload.category_id) return showToast('Seleziona una categoria oppure creane una nuova dal menu Categoria.', 'error');
    if (attachmentFiles.length > MAX_TRANSACTION_ATTACHMENTS) return showToast(`Puoi allegare al massimo ${MAX_TRANSACTION_ATTACHMENTS} foto per movimento.`, 'error');
    if (attachmentFiles.length && (!remoteMode || !getCategory(payload.category_id)?.allowAttachments)) return showToast('Attiva gli allegati nella categoria selezionata prima di aggiungere una foto.', 'error');
    if (!payload.payment_method_id) return showToast('Seleziona un metodo/conto oppure lascia “Non specificato”.', 'error');
    const selectedPaymentMethod = getPaymentMethod(payload.payment_method_id);
    if (!selectedPaymentMethod || selectedPaymentMethod.budgetId !== payload.budget_id || selectedPaymentMethod.archived) return showToast('Il metodo/conto selezionato non è disponibile per questo budget.', 'error');
    const requestedEndDate = form.get('endDate') || maxRecurringEndDate(payload.transaction_date);
    if (recurringEnabled && (requestedEndDate < payload.transaction_date || requestedEndDate > maxRecurringEndDate(payload.transaction_date))) {
      return showToast('La data fine deve rientrare nei 12 mesi dalla data di inizio.', 'error');
    }
    const endDate = recurringEnabled ? requestedEndDate : null;
    if (!(projectedTransaction ? can('add', payload.budget_id) : can(id ? 'edit' : 'add', payload.budget_id))) return showToast('Non hai i permessi per questa operazione.', 'error');
    if (id && existingTransaction?.budgetId !== payload.budget_id && !can('add', payload.budget_id)) return showToast('Non puoi spostare il movimento in questo budget.', 'error');
    if (projectedTransaction) {
      const projectedPayload = { ...payload, transaction_date: projectedTransaction.date, budget_id: projectedTransaction.budgetId, recurring_transaction_id: projectedTransaction.recurringTransactionId };
      if (remoteMode) {
        const result = await supabase.from('transactions').insert({ ...projectedPayload, author_id: state.sessionUserId });
        if (result.error) return showToast(result.error.message.includes('duplicate') ? 'Questa occorrenza è già stata registrata.' : result.error.message, 'error');
        await loadRemoteState(authUser);
      } else {
        state.transactions.unshift({ id: 'tx-' + Date.now(), date: projectedPayload.transaction_date, amount: projectedPayload.amount, type: projectedPayload.type, categoryId: projectedPayload.category_id, paymentMethodId: projectedPayload.payment_method_id, description: projectedPayload.description, budgetId: projectedPayload.budget_id, authorId: state.sessionUserId, isReceived: projectedPayload.is_received, recurringTransactionId: projectedPayload.recurring_transaction_id, recurring: true, isProjected: false });
        persist();
        refreshSummary();
      }
      document.querySelector('#modal-root').innerHTML = '';
      render();
      showToast('Occorrenza modificata. La ricorrenza resta invariata.');
      return;
    }
    let recurringId = existingTransaction?.recurringTransactionId || null;
    let attachmentFailures = [];
    if (remoteMode) {
      if (recurringEnabled) {
        const recurringPayload = { budget_id: payload.budget_id, category_id: payload.category_id, payment_method_id: payload.payment_method_id, author_id: state.sessionUserId, description: payload.description, amount: payload.amount, type, frequency, day_of_period: day, start_date: payload.transaction_date, end_date: endDate, next_insert_date: recurringDate(payload.transaction_date, frequency, day), active: true, is_received: payload.is_received };
        if (recurringId) {
          const { error } = await supabase.from('recurring_transactions').update({ budget_id: recurringPayload.budget_id, category_id: recurringPayload.category_id, payment_method_id: recurringPayload.payment_method_id, description: recurringPayload.description, amount: recurringPayload.amount, type: recurringPayload.type, frequency: recurringPayload.frequency, day_of_period: recurringPayload.day_of_period, start_date: recurringPayload.start_date, end_date: recurringPayload.end_date, is_received: recurringPayload.is_received, active: true }).eq('id', recurringId);
          if (error) return showToast(error.message, 'error');
        } else {
          const { data, error } = await supabase.from('recurring_transactions').insert(recurringPayload).select('id').single();
          if (error) return showToast(error.message, 'error');
          recurringId = data.id;
        }
      } else if (recurringId) {
        const { error } = await supabase.from('recurring_transactions').update({ active: false }).eq('id', recurringId);
        if (error) return showToast(error.message, 'error');
        recurringId = null;
      }
      const transactionPayload = { ...payload, recurring_transaction_id: recurringId };
      const result = id
        ? await supabase.from('transactions').update(transactionPayload).eq('id', id).select('id').single()
        : await supabase.from('transactions').insert({ ...transactionPayload, author_id: state.sessionUserId }).select('id').single();
      if (result.error) return showToast(result.error.message, 'error');
      const savedTransactionId = id || result.data?.id;
      if (attachmentFiles.length && savedTransactionId) {
        attachmentFailures = await uploadTransactionAttachments({ id: savedTransactionId, budgetId: payload.budget_id }, attachmentFiles);
      }
      await loadRemoteState(authUser);
    } else {
      if (recurringEnabled) {
        if (!recurringId) {
          recurringId = 'rec-' + Date.now();
          state.recurringTransactions.push({ id: recurringId, description: payload.description, amount: payload.amount, type, frequency, day, startDate: payload.transaction_date, endDate, nextDate: recurringDate(payload.transaction_date, frequency, day), active: true, budgetId: payload.budget_id, categoryId: payload.category_id, paymentMethodId: payload.payment_method_id, authorId: state.sessionUserId, isReceived: payload.is_received });
        } else {
          const index = state.recurringTransactions.findIndex((item) => item.id === recurringId);
          const current = state.recurringTransactions[index];
          if (index >= 0) state.recurringTransactions[index] = { ...current, description: payload.description, amount: payload.amount, type, frequency, day, startDate: payload.transaction_date, endDate, nextDate: current?.nextDate || recurringDate(payload.transaction_date, frequency, day), active: true, budgetId: payload.budget_id, categoryId: payload.category_id, paymentMethodId: payload.payment_method_id, isReceived: payload.is_received };
        }
      } else if (recurringId) {
        const index = state.recurringTransactions.findIndex((item) => item.id === recurringId);
        if (index >= 0) state.recurringTransactions[index] = { ...state.recurringTransactions[index], active: false };
        recurringId = null;
      }
      const item = { date: payload.transaction_date, amount: payload.amount, type: payload.type, categoryId: payload.category_id, paymentMethodId: payload.payment_method_id, description: payload.description, budgetId: payload.budget_id, authorId: state.sessionUserId, isReceived: payload.is_received, recurringTransactionId: recurringId, recurring: recurringEnabled };
      if (id) {
        const index = state.transactions.findIndex((tx) => tx.id === id);
        if (index >= 0) state.transactions[index] = { ...state.transactions[index], ...item };
      } else state.transactions.unshift({ id: 'tx-' + Date.now(), ...item });
      refreshSummary();
      persist();
    }
    document.querySelector('#modal-root').innerHTML = '';
    render();
    showToast(attachmentFailures.length
      ? `${id ? 'Movimento aggiornato' : 'Movimento aggiunto'}, ma ${attachmentFailures.length} foto non ${attachmentFailures.length === 1 ? 'è stata caricata' : 'sono state caricate'}. ${attachmentFailures[0]}`
      : (id ? 'Movimento aggiornato.' : 'Movimento aggiunto.'), attachmentFailures.length ? 'error' : 'success');
  }
  if (formId === 'payment-method-form') {
    event.preventDefault();
    const form = new FormData(formElement);
    const id = String(form.get('id') || '');
    const budgetId = String(form.get('budgetId') || state.selectedBudgetId);
    const budget = getBudget(budgetId);
    const name = String(form.get('name') || '').trim();
    const kind = String(form.get('kind') || 'altro');
    const initialBalance = Number(form.get('initialBalance'));
    const openingDate = String(form.get('openingDate') || '');
    if (!budget || !can('add', budget.id)) return showToast('Non hai i permessi per gestire i metodi di questo budget.', 'error');
    if (!name) return showToast('Inserisci il nome del metodo o conto.', 'info');
    if (kind === 'non_specificato') return showToast('“Non specificato” è riservato al sistema.', 'error');
    if (!Number.isFinite(initialBalance)) return showToast('Inserisci un saldo iniziale valido.', 'error');
    if (!isValidIsoDate(openingDate)) return showToast('Inserisci una data di saldo iniziale valida.', 'error');
    const currentMethod = id ? getPaymentMethod(id) : null;
    if (id && !canManagePaymentMethod(currentMethod)) return showToast('Puoi modificare solo i metodi creati da te.', 'error');
    if (!remoteMode && state.paymentMethods.some((method) => method.id !== id && method.budgetId === budget.id && normalizeName(method.name) === normalizeName(name))) return showToast('Esiste già un metodo con questo nome in questo budget.', 'error');
    const movementDraft = pendingMovementDraft;
    let savedMethodId = id;
    if (remoteMode) {
      const payload = { name, kind, opening_balance: initialBalance, opening_balance_date: openingDate };
      const result = id
        ? await supabase.from('payment_methods').update(payload).eq('id', id).select('id').single()
        : await supabase.from('payment_methods').insert({ ...payload, budget_id: budget.id, owner_id: state.sessionUserId }).select('id').single();
      if (result.error) return showToast(result.error.message.includes('duplicate') ? 'Esiste già un metodo con questo nome in questo budget.' : result.error.message, 'error');
      savedMethodId = result.data?.id || id;
      await loadRemoteState(authUser);
    } else if (currentMethod) {
      Object.assign(currentMethod, { name, kind, initialBalance, openingDate });
      persist();
    } else {
      savedMethodId = 'pm-' + Date.now();
      state.paymentMethods.push({ id: savedMethodId, budgetId: budget.id, ownerId: state.sessionUserId, name, kind, initialBalance, openingDate, default: false, archived: false, createdAt: new Date().toISOString() });
      persist();
    }
    if (movementDraft && !id) {
      pendingMovementDraft = null;
      openTransactionModal(null, { draft: { ...movementDraft, paymentMethodId: savedMethodId } });
      showToast('Metodo creato. Completa il movimento.');
      return;
    }
    document.querySelector('#modal-root').innerHTML = '';
    render();
    showToast(id ? 'Metodo aggiornato.' : 'Metodo creato.');
    return;
  }
  if (formId === 'payment-method-archive-form') {
    event.preventDefault();
    const form = new FormData(formElement);
    const method = getPaymentMethod(String(form.get('id') || ''));
    if (!canManagePaymentMethod(method)) return showToast('Puoi archiviare solo i metodi creati da te.', 'error');
    if (form.get('confirm') !== 'on' || String(form.get('confirmation') || '').trim() !== method.name) return showToast('Seleziona la conferma e scrivi esattamente il nome del metodo.', 'error');
    if (remoteMode) {
      const { error } = await supabase.from('payment_methods').update({ is_archived: true }).eq('id', method.id);
      if (error) return showToast(error.message, 'error');
      await loadRemoteState(authUser);
    } else {
      method.archived = true;
      persist();
    }
    document.querySelector('#modal-root').innerHTML = '';
    render();
    showToast('Metodo archiviato. Lo storico è stato conservato.');
    return;
  }
  if (formId === 'user-create-form') {
    event.preventDefault();
    if (getUser()?.role !== 'admin') return showToast('Solo l’amministratore può creare utenti.', 'error');
    const form = new FormData(formElement);
    const firstName = String(form.get('firstName') || '').trim();
    const lastName = String(form.get('lastName') || '').trim();
    const email = String(form.get('email') || '').trim().toLowerCase();
    const password = String(form.get('password') || '');
    if (!firstName || !lastName || !email || password.length < 8) return showToast('Compila tutti i campi: la password deve contenere almeno 8 caratteri.', 'error');
    if (!remoteMode) {
      if (state.profiles.some((profile) => String(profile.email || '').toLowerCase() === email)) return showToast('Esiste già un utente con questa email.', 'error');
      state.profiles.push({ id: 'local-user-' + Date.now(), firstName, lastName, email, role: 'standard', status: 'in_attesa' });
      persist();
      document.querySelector('#modal-root').innerHTML = '';
      render();
      showToast('Utente creato e messo in attesa di approvazione.');
      return;
    }
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session?.access_token) return showToast('Sessione amministratore non disponibile. Accedi di nuovo.', 'error');
    let response;
    try {
      response = await fetch('/api/admin/create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionData.session.access_token}` },
        body: JSON.stringify({ firstName, lastName, email, password }),
      });
    } catch (error) {
      return showToast(`Impossibile creare l’utente: ${error.message}`, 'error');
    }
    let result = {};
    try { result = await response.json(); } catch { /* risposta non JSON */ }
    if (!response.ok) return showToast(result.error || 'Impossibile creare l’utente.', 'error');
    await loadRemoteState(authUser);
    document.querySelector('#modal-root').innerHTML = '';
    render();
    showToast('Utente creato e messo in attesa di approvazione.');
    return;
  }
  if (formId === 'inline-category-form') {
    event.preventDefault();
    const form = new FormData(formElement);
    const name = String(form.get('name') || '').trim();
    const budget = getBudget(String(form.get('budgetId') || state.categoryBudgetId || state.selectedBudgetId));
    if (!name) return showToast('Inserisci il nome della categoria.', 'info');
    if (!budget || !can('add', budget.id)) return showToast('Per creare una categoria devi poter inserire movimenti in questo budget.', 'error');
    if (!remoteMode && state.categories.some((category) => category.ownerId === state.sessionUserId && category.name.toLowerCase() === name.toLowerCase())) return showToast('Hai già una categoria con questo nome.', 'error');
    if (remoteMode) {
      const { error } = await supabase.from('categories').insert({ name, type: form.get('type'), owner_id: state.sessionUserId });
      if (error) return showToast(error.message.includes('duplicate') ? 'Hai già una categoria con questo nome.' : error.message, 'error');
      await loadRemoteState(authUser);
    } else {
      state.categories.push({ id: 'cat-' + Date.now(), name, type: form.get('type'), default: false, archived: false, ownerId: state.sessionUserId, icon: iconFor(name), createdAt: new Date().toISOString() });
      persist();
    }
    render();
    showToast('Categoria creata.');
    return;
  }
  if (formId === 'category-edit-form') {
    event.preventDefault();
    const form = new FormData(formElement);
    const category = getCategory(String(form.get('id') || ''));
    const name = String(form.get('name') || '').trim();
    if (!canManageCategory(category)) return showToast('Puoi modificare solo le categorie personali create da te.', 'error');
    if (!name) return showToast('Inserisci il nome della categoria.', 'info');
    if (!remoteMode && state.categories.some((item) => item.id !== category.id && item.ownerId === state.sessionUserId && item.name.toLowerCase() === name.toLowerCase())) return showToast('Hai già una categoria con questo nome.', 'error');
    if (remoteMode) {
      const categoryUpdate = { name, type: form.get('type') };
      if (attachmentsFeatureAvailable) categoryUpdate.allow_attachments = form.get('allowAttachments') === 'on';
      const { error } = await supabase.from('categories').update(categoryUpdate).eq('id', category.id);
      if (error) return showToast(error.message.includes('duplicate') ? 'Hai già una categoria con questo nome.' : error.message, 'error');
      await loadRemoteState(authUser);
    } else {
      Object.assign(category, { name, type: form.get('type'), allowAttachments: form.get('allowAttachments') === 'on', icon: iconFor(name) });
      persist();
    }
    document.querySelector('#modal-root').innerHTML = '';
    render();
    showToast('Categoria aggiornata.');
    return;
  }
  if (formId === 'category-archive-form') {
    event.preventDefault();
    const form = new FormData(formElement);
    const category = getCategory(String(form.get('id') || ''));
    if (!canManageCategory(category)) return showToast('Puoi archiviare solo le categorie personali create da te.', 'error');
    if (form.get('confirm') !== 'on' || String(form.get('confirmation') || '').trim() !== category.name) return showToast('Seleziona la conferma e scrivi esattamente il nome della categoria.', 'error');
    if (remoteMode) {
      const { error } = await supabase.from('categories').update({ is_archived: true }).eq('id', category.id);
      if (error) return showToast(error.message, 'error');
      await loadRemoteState(authUser);
    } else {
      category.archived = true;
      persist();
    }
    document.querySelector('#modal-root').innerHTML = '';
    render();
    showToast('Categoria archiviata. Lo storico è stato conservato.');
    return;
  }
  if (formId === 'category-delete-form') {
    event.preventDefault();
    const form = new FormData(formElement);
    const category = getCategory(String(form.get('id') || ''));
    if (!canManageCategory(category)) return showToast('Puoi eliminare solo le categorie personali create da te.', 'error');
    if (form.get('confirm') !== 'on' || String(form.get('confirmation') || '').trim() !== category.name) return showToast('Seleziona la conferma e scrivi esattamente il nome della categoria.', 'error');
    if (remoteMode) {
      const { error } = await supabase.rpc('delete_category_safely', { p_category_id: category.id });
      if (error) return showToast(error.message, 'error');
      await loadRemoteState(authUser);
    } else {
      state.transactions = state.transactions.filter((transaction) => transaction.categoryId !== category.id);
      state.recurringTransactions = state.recurringTransactions.filter((transaction) => transaction.categoryId !== category.id);
      state.budgetCategories = state.budgetCategories.filter((item) => item.categoryId !== category.id);
      state.categoryLimits = state.categoryLimits.filter((item) => item.categoryId !== category.id);
      state.categories = state.categories.filter((item) => item.id !== category.id);
      persist();
      refreshSummary();
    }
    document.querySelector('#modal-root').innerHTML = '';
    render();
    showToast('Categoria eliminata insieme ai movimenti associati.');
    return;
  }
  if (formId === 'transaction-delete-form') {
    event.preventDefault();
    const form = new FormData(formElement);
    const transaction = findTransactionById(String(form.get('id') || ''));
    if (!transaction) return showToast('Movimento non trovato o già eliminato.', 'error');
    if (form.get('confirm') !== 'on') return showToast('Seleziona la conferma per completare l’operazione.', 'error');
    if (transaction.isProjected) {
      await skipProjectedTransaction(transaction);
      return;
    }
    if (!canDeleteTransaction(transaction)) return showToast('Puoi eliminare solo i tuoi movimenti nei budget in cui puoi inserire dati.', 'error');
    if (remoteMode) {
      const { data, error } = await supabase.from('transactions').delete().eq('id', transaction.id).eq('author_id', state.sessionUserId).select('id').maybeSingle();
      if (error) return showToast(error.message, 'error');
      if (!data) return showToast('Movimento non trovato o già eliminato.', 'error');
      await loadRemoteState(authUser);
    } else {
      state.transactions = state.transactions.filter((item) => item.id !== transaction.id);
      persist();
      refreshSummary();
    }
    document.querySelector('#modal-root').innerHTML = '';
    render();
    showToast('Movimento eliminato.');
    return;
  }
  if (formId === 'category-form') {
    event.preventDefault();
    const form = new FormData(formElement);
    const name = String(form.get('name')).trim();
    if (!name) return;
    const categoryBudget = getBudget(pendingMovementDraft?.budgetId || state.selectedBudgetId);
    if (!categoryBudget || !can('add', categoryBudget.id)) return showToast('Per creare una categoria devi poter inserire movimenti in questo budget.', 'error');
    if (!remoteMode && state.categories.some((category) => category.ownerId === state.sessionUserId && category.name.toLowerCase() === name.toLowerCase())) return showToast('Hai già una categoria con questo nome.', 'error');
    const movementDraft = pendingMovementDraft;
    let createdCategoryId = null;
    if (remoteMode) {
      const { data, error } = await supabase.from('categories').insert({ name, type: form.get('type'), owner_id: state.sessionUserId }).select('id').single();
      if (error) return showToast(error.message, 'error');
      await loadRemoteState(authUser);
      createdCategoryId = data?.id || state.categories.find((category) => category.ownerId === state.sessionUserId && category.name.toLowerCase() === name.toLowerCase())?.id || null;
    } else {
      createdCategoryId = 'cat-' + Date.now();
      state.categories.push({ id: createdCategoryId, name, type: form.get('type'), default: false, archived: false, ownerId: state.sessionUserId, icon: iconFor(name) });
      persist();
    }
    if (movementDraft) {
      pendingMovementDraft = null;
      openTransactionModal(null, { draft: { ...movementDraft, categoryId: createdCategoryId } });
      showToast('Categoria creata. Completa il movimento.');
      return;
    }
    document.querySelector('#modal-root').innerHTML = '';
    render();
    showToast('Categoria creata.');
  }
}

async function handleClick(event) {
  const clickedTypeOption = event.target.closest('.segmented-control label');
  if (clickedTypeOption) {
    const input = clickedTypeOption.querySelector('input[name="type"]');
    if (input) {
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
  }
  const target = event.target.closest('[data-action], [data-page], [data-month], [data-category], [data-admin-tab]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'dashboard-month') {
    const months = dashboardMonths();
    const currentKey = months.some((item) => item.key === state.dashboardMonth)
      ? state.dashboardMonth
      : months.find((item) => item.key === DEFAULT_DASHBOARD_MONTH)?.key || months[0]?.key;
    const currentIndex = Math.max(0, months.findIndex((item) => item.key === currentKey));
    const nextIndex = currentIndex + (target.dataset.direction === 'previous' ? -1 : 1);
    if (months[nextIndex]) {
      state.dashboardMonth = months[nextIndex].key;
      persist();
      render();
    }
    return;
  }
  if (action === 'toggle-dashboard-chart') {
    state.dashboardChartView = state.dashboardChartView === 'annual' ? 'monthly' : 'annual';
    persist();
    render();
    return;
  }
  if (action === 'dashboard-report-view') {
    state.dashboardReportView = ['cashflow', 'categories', 'methods'].includes(target.dataset.view) ? target.dataset.view : 'cashflow';
    persist();
    render();
    return;
  }
  if (action === 'dashboard-filter') {
    openTransactions({
      month: target.dataset.period || 'all',
      type: target.dataset.type || 'all',
      category: target.dataset.category || 'all',
      incomeStatus: target.dataset.incomeStatus || 'all',
      paymentMethod: target.dataset.paymentMethod || 'all',
    });
    return;
  }
  if (action === 'demo-login') {
    state.sessionUserId = 'user-leo';
    state.currentPage = 'dashboard';
    persist();
    render();
    showToast('Accesso effettuato. Benvenuto in MyBudget!');
    return;
  }
  if (action === 'logout') {
    if (remoteMode) await supabase.auth.signOut();
    state.sessionUserId = null;
    persist();
    render();
    return;
  }
  if (action === 'show-register') {
    event.preventDefault();
    document.querySelector('.auth-card').innerHTML = '<div class="auth-card-heading"><span class="eyebrow">Nuovo spazio</span><h2>Crea il tuo account</h2><p>La richiesta verrà verificata da un amministratore.</p></div><form id="register-form" class="form-stack"><div class="form-grid"><label>Nome<input name="firstName" required placeholder="Nome" /></label><label>Cognome<input name="lastName" required placeholder="Cognome" /></label></div><label>Email<input name="email" type="email" required placeholder="nome@email.it" /></label><label>Password<input name="password" type="password" minlength="8" required placeholder="Almeno 8 caratteri" /></label><button class="button button-primary button-block" type="submit">Invia richiesta <span>→</span></button></form><p class="auth-switch">Hai già un account? <a href="#" data-action="back-login">Torna al login</a></p>';
    return;
  }
  if (action === 'back-login') { event.preventDefault(); render(); return; }
  if (action === 'toggle-password') {
    const input = target.parentElement.querySelector('input');
    input.type = input.type === 'password' ? 'text' : 'password';
    return;
  }
  if (action === 'forgot-password') {
    event.preventDefault();
    if (!remoteMode) return showToast('Il recupero password è disponibile collegando Supabase.', 'info');
    const email = document.querySelector('#login-form input[name="email"]')?.value;
    if (!email) return showToast('Inserisci prima la tua email.', 'info');
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
    showToast(error ? error.message : 'Istruzioni inviate per email.', error ? 'error' : 'success');
    return;
  }
  if (action === 'new-budget') { openBudgetModal(); return; }
  if (action === 'manage-budget-access') { await openBudgetAccessModal(target.dataset.id); return; }
  if (action === 'archive-budget') { await openBudgetActionModal(target.dataset.id, 'archive'); return; }
  if (action === 'delete-budget') { await openBudgetActionModal(target.dataset.id, 'delete'); return; }
  if (action === 'restore-budget') {
    const budget = getAnyBudget(target.dataset.id);
    if (!budget || !isBudgetOwner(budget)) return showToast('Solo il proprietario può ripristinare questo budget.', 'error');
    if (remoteMode) {
      const { error } = await supabase.from('budgets').update({ archived_at: null }).eq('id', budget.id);
      if (error) return showToast(error.message, 'error');
      await loadRemoteState(authUser);
    } else {
      state.archivedBudgets = state.archivedBudgets.filter((item) => item.id !== budget.id);
      state.budgets.push({ ...budget, archivedAt: null });
      persist();
    }
    state.selectedBudgetId ||= state.budgets[0]?.id;
    render();
    showToast('Budget ripristinato.');
    return;
  }
  if (action === 'new-admin-budget') { openAdminBudgetModal(target.dataset.userId); return; }
  if (action === 'admin-archive-budget') { await openBudgetActionModal(target.dataset.id, 'archive', 'admin'); return; }
  if (action === 'admin-delete-budget') { await openBudgetActionModal(target.dataset.id, 'delete', 'admin'); return; }
  if (action === 'remove-budget-access') {
    const budget = getAnyBudget(target.dataset.budgetId);
    if (!budget || !isBudgetOwner(budget)) return showToast('Solo il proprietario può gestire la condivisione.', 'error');
    if (remoteMode) {
      const { error } = await supabase.rpc('remove_budget_access', { p_budget_id: budget.id, p_user_id: target.dataset.userId });
      if (error) return showToast(error.message, 'error');
      await loadRemoteState(authUser);
    } else {
      state.budgetMembers = state.budgetMembers.filter((item) => !(item.budgetId === budget.id && item.userId === target.dataset.userId));
      state.budgetAccess[budget.id] = budgetAccessFor(budget.id);
      persist();
    }
    await openBudgetAccessModal(budget.id);
    showToast('Accesso rimosso.');
    return;
  }
  if (action === 'new-transaction') { openTransactionModal(); return; }
  if (action === 'new-payment-method') { openPaymentMethodModal(null, { budgetId: target.dataset.budgetId || state.paymentMethodBudgetId || state.selectedBudgetId }); return; }
  if (action === 'edit-payment-method') { openPaymentMethodModal(getPaymentMethod(target.dataset.id)); return; }
  if (action === 'archive-payment-method') { openPaymentMethodArchiveModal(target.dataset.id); return; }
  if (action === 'open-import') { openImportModal(); return; }
  if (action === 'new-user') { openUserModal(); return; }
  if (action === 'sync-admin-users') {
    if (getUser()?.role !== 'admin') return showToast('Solo l’amministratore può aggiornare le richieste.', 'error');
    try {
      const result = await syncAdminProfiles();
      if (Number(result.synced) > 0) await loadRemoteState(authUser);
      render();
      showToast(Number(result.synced) > 0 ? `Sincronizzati ${result.synced} nuovi account.` : 'La lista utenti è già aggiornata.');
    } catch (error) {
      showToast(error.message, 'error');
    }
    return;
  }
  if (action === 'inspect-import') { await prepareImportPreview(); return; }
  if (action === 'confirm-import') { await commitImport(); return; }
  if (action === 'submit-transaction') {
    event.preventDefault();
    const form = target.closest('form');
    if (form) await handleSubmit({ target: form, preventDefault() {} });
    return;
  }
  if (action === 'new-category') { openCategoryModal(); return; }
  if (action === 'edit-category') { openCategoryEditModal(target.dataset.id); return; }
  if (action === 'archive-category') { openCategoryArchiveModal(target.dataset.id); return; }
  if (action === 'delete-category') { await openCategoryDeleteModal(target.dataset.id); return; }
  if (action === 'category-view') {
    state.categoryView = target.dataset.view === 'year' ? 'year' : 'month';
    persist();
    render();
    return;
  }
  if (action === 'category-month') {
    const months = dashboardMonths();
    const currentKey = months.some((item) => item.key === state.categoryMonth) ? state.categoryMonth : DEFAULT_DASHBOARD_MONTH;
    const currentIndex = Math.max(0, months.findIndex((item) => item.key === currentKey));
    const nextIndex = currentIndex + (target.dataset.direction === 'previous' ? -1 : 1);
    if (months[nextIndex]) {
      state.categoryMonth = months[nextIndex].key;
      persist();
      render();
    }
    return;
  }
  if (action === 'payment-method-month') {
    const months = Array.from({ length: 12 }, (_, index) => `${APP_YEAR}-${String(index + 1).padStart(2, '0')}`);
    const currentKey = months.includes(state.paymentMethodMonth) ? state.paymentMethodMonth : DEFAULT_DASHBOARD_MONTH;
    const currentIndex = Math.max(0, months.indexOf(currentKey));
    const nextIndex = currentIndex + (target.dataset.direction === 'previous' ? -1 : 1);
    if (months[nextIndex]) {
      state.paymentMethodMonth = months[nextIndex];
      persist();
      render();
    }
    return;
  }
  if (action === 'materialize-projected') { await materializeProjectedTransaction(findTransactionById(target.dataset.id)); return; }
  if (action === 'view-transaction-attachments') { await openTransactionAttachments(target.dataset.id); return; }
  if (action === 'edit-transaction') { openTransactionModal(findTransactionById(target.dataset.id)); return; }
  if (action === 'delete-transaction') { openTransactionDeleteModal(target.dataset.id); return; }
  if (action === 'close-modal') {
    if (!event.target.closest('[data-stop-propagation]') || event.target === target) {
      const returnToMovement = document.querySelector('#modal-root [data-return-to-movement="true"]');
      if (returnToMovement && pendingMovementDraft) {
        const draft = pendingMovementDraft;
        pendingMovementDraft = null;
        openTransactionModal(null, { draft });
        return;
      }
      document.querySelector('#modal-root').innerHTML = '';
    }
    return;
  }
  if (action === 'clear-filters') { state.transactionFilters = { month: 'all', type: 'all', category: 'all', incomeStatus: 'all', paymentMethod: 'all', query: '' }; persist(); render(); return; }
  if (action === 'export-data') {
    const filename = downloadBudgetExport(state);
    return showToast(`Backup Excel scaricato: ${filename}`);
  }
  if (action === 'coming-soon') return showToast('Questa funzione sarà disponibile nel prossimo passaggio.', 'info');
  if (action === 'reset-demo') return showToast('Il seed del database è già stato applicato.', 'info');
  if (action === 'toggle-user') {
    if (target.dataset.id === state.sessionUserId) return showToast('Non puoi disabilitare il tuo account amministratore.', 'error');
    const nextStatus = target.dataset.status;
    if (remoteMode) {
      const { error } = await supabase.from('profiles').update({ status: nextStatus }).eq('id', target.dataset.id);
      if (error) return showToast(error.message, 'error');
      await loadRemoteState(authUser);
    } else {
      const profile = getUser(target.dataset.id);
      if (profile) profile.status = nextStatus;
      persist();
    }
    render();
    showToast(nextStatus === 'attivo' ? 'Utente abilitato.' : 'Utente disabilitato.');
    return;
  }
  if (action === 'approve-user') {
    if (remoteMode) {
      const { error } = await supabase.from('profiles').update({ status: 'attivo' }).eq('id', target.dataset.id);
      if (error) return showToast(error.message, 'error');
      await loadRemoteState(authUser);
    } else {
      const profile = getUser(target.dataset.id);
      if (profile) profile.status = 'attivo';
      persist();
    }
    render();
    showToast('Profilo approvato.');
    return;
  }
  if (action === 'toggle-sidebar') { document.querySelector('.sidebar')?.classList.toggle('is-open'); return; }
  if (target.dataset.category) {
    state.transactionFilters = { ...state.transactionFilters, type: target.dataset.summaryType || state.transactionFilters.type || 'all', incomeStatus: target.dataset.summaryType === 'uscita' ? 'all' : state.transactionFilters.incomeStatus || 'all', category: target.dataset.category };
    setPage('transactions');
    return;
  }
  if (target.dataset.page) { setPage(target.dataset.page); return; }
  if (target.dataset.month) { openTransactions({ month: target.dataset.month }); return; }
  if (target.dataset.adminTab) {
    state.adminTab = target.dataset.adminTab;
    persist();
    render();
  }
}

async function handleChange(event) {
  if (event.target.dataset.change === 'budget') { state.selectedBudgetId = event.target.value; refreshSummary(); persist(); render(); }
  if (event.target.dataset.change === 'category-budget') { state.categoryBudgetId = event.target.value; persist(); render(); }
  if (event.target.dataset.change === 'payment-method-budget') { state.paymentMethodBudgetId = event.target.value; state.paymentMethodMonth = state.dashboardMonth || DEFAULT_DASHBOARD_MONTH; persist(); render(); }
  if (event.target.dataset.filter) { state.transactionFilters[event.target.dataset.filter] = event.target.value; persist(); render(); }
  if (event.target.dataset.accessLevel) {
    const budget = getAnyBudget(event.target.dataset.budgetId);
    if (!budget || !isBudgetOwner(budget)) return showToast('Solo il proprietario può gestire la condivisione.', 'error');
    const level = event.target.value;
    if (remoteMode) {
      const { error } = await supabase.rpc('update_budget_access', { p_budget_id: budget.id, p_user_id: event.target.dataset.userId, p_can_view: true, p_can_add: level !== 'view', p_can_edit: level === 'edit' });
      if (error) return showToast(error.message, 'error');
      await loadRemoteState(authUser);
    } else {
      const member = state.budgetMembers.find((item) => item.budgetId === budget.id && item.userId === event.target.dataset.userId);
      if (member) Object.assign(member, { view: true, add: level !== 'view', edit: level === 'edit', manage: false });
      state.budgetAccess[budget.id] = budgetAccessFor(budget.id);
      persist();
    }
    showToast('Permessi aggiornati.');
  }
  if (event.target.dataset.importFile !== undefined) {
    const fileName = document.querySelector('[data-import-file-name]');
    if (fileName) fileName.textContent = event.target.files?.[0]?.name || 'Nessun file selezionato';
  }
  if (event.target.matches('[data-import-exclude-all]')) {
    document.querySelectorAll('[data-import-exclude]').forEach((input) => { input.checked = event.target.checked; });
    syncImportCommitLabel();
  }
  if (event.target.matches('[data-import-exclude]')) syncImportCommitLabel();
  if (event.target.name === 'type' && event.target.closest('#transaction-form')) {
    const form = event.target.closest('#transaction-form');
    const isIncome = form.querySelector('input[name="type"]:checked')?.value === 'entrata';
    form.querySelector('.income-status-field')?.classList.toggle('hidden', !isIncome);
    if (!isIncome) {
      const received = form.querySelector('input[name="isReceived"]');
      if (received) received.checked = true;
    }
  }
  if (event.target.name === 'categoryId' && event.target.value === 'new') {
    const form = event.target.closest('#transaction-form');
    pendingMovementDraft = form ? readTransactionDraft(form) : null;
    event.target.value = '';
    openCategoryModal({ fromMovement: true, budgetId: pendingMovementDraft?.budgetId });
  }
  if (event.target.name === 'paymentMethodId' && event.target.value === 'new') {
    const form = event.target.closest('#transaction-form');
    pendingMovementDraft = form ? readTransactionDraft(form) : null;
    event.target.value = defaultPaymentMethodForBudget(pendingMovementDraft?.budgetId)?.id || '';
    openPaymentMethodModal(null, { fromMovement: true, budgetId: pendingMovementDraft?.budgetId });
  }
}

document.addEventListener('submit', (event) => {
  event.preventDefault();
  handleSubmit(event).catch((error) => showToast(error.message, 'error'));
}, true);
document.addEventListener('click', (event) => handleClick(event).catch((error) => showToast(error.message, 'error')));
document.addEventListener('change', (event) => handleChange(event).catch((error) => showToast(error.message, 'error')));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') document.querySelector('#modal-root').innerHTML = '';
  if ((event.key === 'Enter' || event.key === ' ') && event.target.closest?.('[role="button"]') && event.target.closest('[role="button"]').tagName !== 'BUTTON') {
    event.preventDefault();
    event.target.closest('[role="button"]').click();
  }
});

render();
init();
