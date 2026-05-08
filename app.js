'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO DE PERSISTENCIA
// ═══════════════════════════════════════════════════════════════════════════
const Storage = (() => {
  const KEY = 'aquaops_data';

  const defaultData = {
    tanks: [],
    settings: { autoRefreshInterval: 30, defaultProjectionHours: 24 },
    lastUpdated: null
  };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(defaultData);
      return JSON.parse(raw);
    } catch (e) {
      console.error('Error cargando datos:', e);
      return structuredClone(defaultData);
    }
  }

  function save(data) {
    try {
      data.lastUpdated = new Date().toISOString();
      localStorage.setItem(KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      console.error('Error guardando datos:', e);
      return false;
    }
  }

  return { load, save };
})();

// ═══════════════════════════════════════════════════════════════════════════
// MOTOR DE CÁLCULO
// ═══════════════════════════════════════════════════════════════════════════
const Calculator = (() => {

  function currentVolume(tank) {
    return tank.area * tank.currentLevelM;
  }

  function totalVolume(tank) {
    return tank.area * tank.height;
  }

  function levelPercent(tank) {
    if (tank.height <= 0) return 0;
    return Math.min(100, Math.max(0, (tank.currentLevelM / tank.height) * 100));
  }

  function netFlow(tank) {
    return (tank.currentInflow || 0) - (tank.outflow || 0);
  }

  function trend(tank) {
    const net = netFlow(tank);
    if (Math.abs(net) < 0.01) return 'stable';
    return net > 0 ? 'filling' : 'draining';
  }

  function timeToFull(tank) {
    const net = netFlow(tank);
    if (net <= 0) return null;
    const remaining = totalVolume(tank) - currentVolume(tank);
    if (remaining <= 0) return 0;
    return remaining / net;
  }

  function timeToTarget(tank) {
    const net = netFlow(tank);
    if (net <= 0 || !tank.targetLevelM) return null;
    const targetVol = tank.area * tank.targetLevelM;
    const curVol = currentVolume(tank);
    if (curVol >= targetVol) return 0;
    return (targetVol - curVol) / net;
  }

  function timeToEmpty(tank) {
    const net = netFlow(tank);
    if (net >= 0) return null;
    const vol = currentVolume(tank);
    if (vol <= 0) return 0;
    return vol / Math.abs(net);
  }

  function projectLevel(tank, hoursAhead) {
    const net = netFlow(tank);
    const currentVol = currentVolume(tank);
    const projectedVol = currentVol + (net * hoursAhead);
    const clampedVol = Math.min(Math.max(0, projectedVol), totalVolume(tank));
    return tank.area > 0 ? clampedVol / tank.area : 0;
  }

  function requiredInflow(tank, hoursToTarget) {
    if (!tank.targetLevelM || hoursToTarget <= 0 || tank.area <= 0) return null;
    const targetVol = tank.area * tank.targetLevelM;
    const currentVol = currentVolume(tank);
    const neededNetFlow = (targetVol - currentVol) / hoursToTarget;
    const inflow = neededNetFlow + (tank.outflow || 0);
    return Math.max(0, Math.min(inflow, tank.maxInflow));
  }

  function projectAtTime(tank, timeStr) {
    const now = new Date();
    const [hh, mm] = timeStr.split(':').map(Number);
    let target = new Date(now);
    target.setHours(hh, mm, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    const hoursAhead = (target - now) / 3600000;
    const levelM = projectLevel(tank, hoursAhead);
    const levelPct = (levelM / tank.height) * 100;
    return {
      levelM,
      levelPct: Math.min(100, Math.max(0, levelPct)),
      hoursAhead
    };
  }

  function evaluateAlerts(tank) {
    const alerts = [];
    if (!tank.alerts) return alerts;

    const currentPct = levelPercent(tank);
    const currentM   = tank.currentLevelM;

    if (tank.alerts.lowLevel && tank.alerts.lowLevel.enabled) {
      const t = tank.alerts.lowLevel;
      const triggered = t.unit === 'percent'
        ? currentPct <= t.value
        : currentM   <= t.value;
      if (triggered) {
        alerts.push({
          type: 'low', severity: 'warning',
          message: `Nivel bajo: ${t.unit === 'percent'
            ? currentPct.toFixed(1) + '% ≤ ' + t.value + '%'
            : currentM.toFixed(2)   + 'm ≤ '  + t.value + 'm'}`,
          tank: tank.name
        });
      }
    }

    if (tank.alerts.criticalLevel && tank.alerts.criticalLevel.enabled) {
      const t = tank.alerts.criticalLevel;
      const triggered = t.unit === 'percent'
        ? currentPct <= t.value
        : currentM   <= t.value;
      if (triggered) {
        alerts.push({
          type: 'critical', severity: 'danger',
          message: `⚠️ NIVEL CRÍTICO: ${t.unit === 'percent'
            ? currentPct.toFixed(1) + '% ≤ ' + t.value + '%'
            : currentM.toFixed(2)   + 'm ≤ '  + t.value + 'm'}`,
          tank: tank.name
        });
      }
    }

    const ttf = timeToFull(tank);
    if (ttf !== null && ttf < 1) {
      alerts.push({
        type: 'overflow', severity: 'danger',
        message: `Rebose inminente en ${formatTime(ttf)}`,
        tank: tank.name
      });
    }

    const tte = timeToEmpty(tank);
    if (tte !== null && tte < 2) {
      alerts.push({
        type: 'empty', severity: 'warning',
        message: `Vaciado en ${formatTime(tte)}`,
        tank: tank.name
      });
    }

    return alerts;
  }

  function getSystemHealth(tanks) {
    if (tanks.length === 0) return 100;
    const allAlerts = tanks.flatMap(t => evaluateAlerts(t));
    const criticals = allAlerts.filter(a => a.severity === 'danger').length;
    const warnings  = allAlerts.filter(a => a.severity === 'warning').length;
    
    let score = 100 - (criticals * 25) - (warnings * 10);
    return Math.max(0, score);
  }

  function formatTime(hours) {
    if (hours === null || hours === undefined || isNaN(hours)) return '—';
    if (hours === Infinity || hours > 9999) return '> 9999h';
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    if (h === 0) return `${m}min`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}min`;
  }

  function generateProjectionPoints(tank, hours, steps = 25) {
    const points = [];
    const now = new Date();
    for (let i = 0; i <= steps; i++) {
      const h = (hours / steps) * i;
      const t = new Date(now.getTime() + h * 3600000);
      const levelM   = projectLevel(tank, h);
      const levelPct = Math.min(100, Math.max(0, (levelM / tank.height) * 100));
      points.push({
        time: t,
        timeLabel: t.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
        levelM:   parseFloat(levelM.toFixed(3)),
        levelPct: parseFloat(levelPct.toFixed(2)),
        hoursAhead: h
      });
    }
    return points;
  }

  return {
    currentVolume, totalVolume, levelPercent, netFlow, trend,
    timeToFull, timeToEmpty, projectLevel, projectAtTime,
    evaluateAlerts, getSystemHealth, formatTime, generateProjectionPoints, timeToTarget,
    requiredInflow
  };
})();

// ═══════════════════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════════════════
const UI = (() => {

  function showToast(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
      <span class="toast-message">${message}</span>
      <button class="toast-close" onclick="this.parentElement.remove()">×</button>
    `;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('toast-show'), 10);
    setTimeout(() => {
      toast.classList.remove('toast-show');
      setTimeout(() => toast.remove(), 400);
    }, duration);
  }

  function confirm(message) {
    return new Promise((resolve) => {
      const modal = document.getElementById('confirmModal');
      document.getElementById('confirmMessage').textContent = message;
      modal.classList.add('active');
      const okBtn     = document.getElementById('confirmOk');
      const cancelBtn = document.getElementById('confirmCancel');
      const cleanup   = () => modal.classList.remove('active');
      okBtn.onclick     = () => { cleanup(); resolve(true); };
      cancelBtn.onclick = () => { cleanup(); resolve(false); };
    });
  }

  function getTrendIcon(trendType) {
    const icons = {
      filling:  '<span class="trend-badge trend-filling">▲ Llenando</span>',
      draining: '<span class="trend-badge trend-draining">▼ Vaciando</span>',
      stable:   '<span class="trend-badge trend-stable">● Estable</span>'
    };
    return icons[trendType] || icons.stable;
  }

  function getLevelClass(pct) {
    if (pct >= 80) return 'level-high';
    if (pct >= 40) return 'level-medium';
    if (pct >= 20) return 'level-low';
    return 'level-critical';
  }

  function formatNumber(n, decimals = 2) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return parseFloat(n).toLocaleString('es-CO', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  function generateId() {
    return 'tank_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  return { showToast, confirm, getTrendIcon, getLevelClass, formatNumber, generateId };
})();

// ═══════════════════════════════════════════════════════════════════════════
// GRÁFICOS
// ═══════════════════════════════════════════════════════════════════════════
const Charts = (() => {
  const instances = {};

  function destroy(id) {
    if (instances[id]) {
      instances[id].destroy();
      delete instances[id];
    }
  }

  function createSystemProjectionChart(canvasId, tanks, hours = 24) {
    destroy(canvasId);
    const canvas = document.getElementById(canvasId);
    if (!canvas || tanks.length === 0) return;

    const steps = hours <= 12 ? 13 : 25;
    const now   = new Date();
    const labels = [];
    for (let i = 0; i <= steps - 1; i++) {
      const t = new Date(now.getTime() + (hours / (steps - 1)) * i * 3600000);
      labels.push(t.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }));
    }

    const datasets = tanks.map(tank => {
      const points = Calculator.generateProjectionPoints(tank, hours, steps - 1);
      return {
        label: tank.name,
        data: points.map(p => p.levelPct),
        borderColor: tank.color || '#0ea5e9',
        backgroundColor: (tank.color || '#0ea5e9') + '20',
        borderWidth: 2.5,
        fill: false,
        tension: 0.3,
        pointRadius: 3,
        pointHoverRadius: 6
      };
    });

    datasets.push({
      label: 'Rebose (100%)',
      data: Array(steps).fill(100),
      borderColor: '#ef4444',
      borderWidth: 1.5,
      borderDash: [6, 4],
      fill: false,
      pointRadius: 0,
      tension: 0
    });

    instances[canvasId] = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { color: '#94a3b8', font: { size: 12 } } },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.dataset.label}: ${UI.formatNumber(ctx.parsed.y, 1)}%`
            }
          }
        },
        scales: {
          x: { ticks: { color: '#64748b', maxTicksLimit: 12 }, grid: { color: '#1e293b' } },
          y: {
            min: 0, max: 105,
            ticks: { color: '#64748b', callback: v => v + '%' },
            grid: { color: '#1e293b' }
          }
        }
      }
    });
  }

  function createProjectionChart(canvasId, tanksData, hours = 24) {
    destroy(canvasId);
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const steps  = 25;
    const now    = new Date();
    const labels = [];
    for (let i = 0; i < steps; i++) {
      const t = new Date(now.getTime() + (hours / (steps - 1)) * i * 3600000);
      labels.push(t.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }));
    }

    const datasets = [];
    tanksData.forEach(({ tank, points }) => {
      datasets.push({
        label: `${tank.name} (%)`,
        data: points.map(p => p.levelPct),
        borderColor: tank.color || '#0ea5e9',
        backgroundColor: (tank.color || '#0ea5e9') + '15',
        borderWidth: 2.5,
        fill: true,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 5,
        yAxisID: 'yPct'
      });
    });

    datasets.push({
      label: 'Nivel Crítico (20%)',
      data: Array(steps).fill(20),
      borderColor: '#f97316',
      borderWidth: 1,
      borderDash: [4, 4],
      fill: false,
      pointRadius: 0,
      yAxisID: 'yPct'
    });

    instances[canvasId] = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { color: '#94a3b8', font: { size: 12 } } },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.dataset.label}: ${UI.formatNumber(ctx.parsed.y, 1)}%`
            }
          }
        },
        scales: {
          x: { ticks: { color: '#64748b', maxTicksLimit: 13 }, grid: { color: '#1e293b' } },
          yPct: {
            type: 'linear', position: 'left',
            min: 0, max: 105,
            ticks: { color: '#64748b', callback: v => v + '%' },
            grid: { color: '#1e293b' }
          }
        }
      }
    });
  }

  return { createSystemProjectionChart, createProjectionChart, destroy };
})();

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTACIÓN
// ═══════════════════════════════════════════════════════════════════════════
const Exporter = (() => {

  function getStatusData(tanks) {
    return tanks.map(tank => {
      const pct      = Calculator.levelPercent(tank);
      const vol      = Calculator.currentVolume(tank);
      const totalVol = Calculator.totalVolume(tank);
      const trendType = Calculator.trend(tank);
      const ttf      = Calculator.timeToFull(tank);
      const tte      = Calculator.timeToEmpty(tank);
      const net      = Calculator.netFlow(tank);
      return {
        'Tanque':                  tank.name,
        'Nivel (m)':               tank.currentLevelM.toFixed(2),
        'Nivel (%)':               pct.toFixed(1),
        'Volumen Actual (m³)':     vol.toFixed(2),
        'Volumen Total (m³)':      totalVol.toFixed(2),
        'Caudal Entrada (m³/h)':   (tank.currentInflow || 0).toFixed(2),
        'Caudal Salida (m³/h)':    (tank.outflow || 0).toFixed(2),
        'Caudal Neto (m³/h)':      net.toFixed(2),
        'Tendencia':               trendType === 'filling' ? 'Llenando' : trendType === 'draining' ? 'Vaciando' : 'Estable',
        'Tiempo hasta Lleno':      Calculator.formatTime(ttf),
        'Tiempo hasta Vacío':      Calculator.formatTime(tte)
      };
    });
  }

  function getProjectionData(tanks, hours) {
    const steps = hours <= 12 ? 12 : 24;
    const now   = new Date();
    const rows  = [];
    for (let i = 0; i <= steps; i++) {
      const h   = (hours / steps) * i;
      const t   = new Date(now.getTime() + h * 3600000);
      const row = {
        'Hora': t.toLocaleString('es-CO', {
          hour: '2-digit', minute: '2-digit',
          day: '2-digit', month: '2-digit'
        })
      };
      tanks.forEach(tank => {
        const levelM   = Calculator.projectLevel(tank, h);
        const levelPct = Math.min(100, Math.max(0, (levelM / tank.height) * 100));
        row[`${tank.name} (m)`]  = levelM.toFixed(2);
        row[`${tank.name} (%)`]  = levelPct.toFixed(1);
      });
      rows.push(row);
    }
    return rows;
  }

  function getConfigData(tanks) {
    return tanks.map(tank => ({
      'Tanque':                    tank.name,
      'Altura Total (m)':          tank.height,
      'Área Base (m²)':            tank.area,
      'Volumen Total (m³)':        Calculator.totalVolume(tank).toFixed(2),
      'Caudal Máx. Entrada (m³/h)': tank.maxInflow,
      'Caudal Salida Param. (m³/h)': tank.outflow,
      'Nivel Actual (m)':          UI.formatNumber(tank.currentLevelM, 3),
      'Nivel Objetivo (m)':        tank.targetLevelM ? UI.formatNumber(tank.targetLevelM, 3) : 'No definido',
      'Alerta Nivel Bajo':         tank.alerts?.lowLevel?.enabled
        ? `${tank.alerts.lowLevel.value} ${tank.alerts.lowLevel.unit === 'percent' ? '%' : 'm'}`
        : 'No configurada',
      'Alerta Nivel Crítico':      tank.alerts?.criticalLevel?.enabled
        ? `${tank.alerts.criticalLevel.value} ${tank.alerts.criticalLevel.unit === 'percent' ? '%' : 'm'}`
        : 'No configurada'
    }));
  }

  function exportToExcel(data, sheetName, fileName) {
    const ws   = XLSX.utils.json_to_sheet(data);
    const wb   = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const cols = Object.keys(data[0] || {}).map(k => ({ wch: Math.max(k.length, 14) }));
    ws['!cols'] = cols;
    XLSX.writeFile(wb, `${fileName}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function exportToPDF(title, headers, rows, fileName) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, 297, 25, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('💧 AquaOps — Sistema de Gestión de Tanques', 14, 10);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(title, 14, 18);
    doc.text(`Generado: ${new Date().toLocaleString('es-CO')}`, 200, 18);

    doc.autoTable({
      head: [headers],
      body: rows,
      startY: 30,
      theme: 'grid',
      headStyles:          { fillColor: [14, 165, 233], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
      bodyStyles:          { fontSize: 8, textColor: [30, 41, 59] },
      alternateRowStyles:  { fillColor: [241, 245, 249] },
      margin:              { left: 14, right: 14 }
    });

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text(`Página ${i} de ${pageCount}`, 14, doc.internal.pageSize.height - 8);
      doc.text('AquaOps v2.0 — Confidencial', 200, doc.internal.pageSize.height - 8);
    }
    doc.save(`${fileName}_${new Date().toISOString().slice(0, 10)}.pdf`);
  }

  function exportStatusPDF(tanks) {
    const data = getStatusData(tanks);
    if (!data.length) { UI.showToast('No hay tanques para exportar', 'warning'); return; }
    exportToPDF('Reporte de Estado Actual', Object.keys(data[0]), data.map(r => Object.values(r)), 'AquaOps_Estado');
    UI.showToast('PDF de estado exportado correctamente', 'success');
  }

  function exportStatusExcel(tanks) {
    const data = getStatusData(tanks);
    if (!data.length) { UI.showToast('No hay tanques para exportar', 'warning'); return; }
    exportToExcel(data, 'Estado Actual', 'AquaOps_Estado');
    UI.showToast('Excel de estado exportado correctamente', 'success');
  }

  function exportProjectionPDF(tanks, hours) {
    const data = getProjectionData(tanks, hours);
    if (!data.length) { UI.showToast('No hay datos para exportar', 'warning'); return; }
    exportToPDF(`Proyección — ${hours}h`, Object.keys(data[0]), data.map(r => Object.values(r)), 'AquaOps_Proyeccion');
    UI.showToast('PDF de proyección exportado correctamente', 'success');
  }

  function exportProjectionExcel(tanks, hours) {
    const data = getProjectionData(tanks, hours);
    if (!data.length) { UI.showToast('No hay datos para exportar', 'warning'); return; }
    exportToExcel(data, `Proyección ${hours}h`, 'AquaOps_Proyeccion');
    UI.showToast('Excel de proyección exportado correctamente', 'success');
  }

  function exportConfigPDF(tanks) {
    const data = getConfigData(tanks);
    if (!data.length) { UI.showToast('No hay tanques para exportar', 'warning'); return; }
    exportToPDF('Configuración de Tanques', Object.keys(data[0]), data.map(r => Object.values(r)), 'AquaOps_Configuracion');
    UI.showToast('PDF de configuración exportado correctamente', 'success');
  }

  function exportConfigExcel(tanks) {
    const data = getConfigData(tanks);
    if (!data.length) { UI.showToast('No hay tanques para exportar', 'warning'); return; }
    exportToExcel(data, 'Configuración', 'AquaOps_Configuracion');
    UI.showToast('Excel de configuración exportado correctamente', 'success');
  }

  function exportConfigurationJSON(tanks) {
    const data = Storage.load();
    const exportData = {
      version: '2.0.0',
      exportDate: new Date().toISOString(),
      tanks: data.tanks,
      settings: data.settings
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `AquaOps_Config_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    UI.showToast('Configuración exportada correctamente', 'success');
  }

  function importConfigurationJSON(fileContent) {
    try {
      const importedData = JSON.parse(fileContent);

      // Validar estructura
      if (!importedData.tanks || !Array.isArray(importedData.tanks)) {
        throw new Error('Formato de archivo inválido: no contiene array de tanques');
      }

      // Validar versión
      if (importedData.version && importedData.version !== '2.0.0') {
        console.warn(`Versión diferente: ${importedData.version}`);
      }

      // Validar cada tanque
      importedData.tanks.forEach((tank, idx) => {
        if (!tank.name || tank.height === undefined || tank.area === undefined) {
          throw new Error(`Tanque ${idx + 1}: datos incompletos`);
        }
        // Asegurar que los niveles existan en el registro importado
        tank.currentLevelM = tank.currentLevelM !== undefined ? tank.currentLevelM : 0;
        tank.targetLevelM  = tank.targetLevelM  !== undefined ? tank.targetLevelM  : null;
        tank.currentInflow = tank.currentInflow !== undefined ? tank.currentInflow : 0;
      });

      return { success: true, data: importedData };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  return {
    exportStatusPDF, exportStatusExcel,
    exportProjectionPDF, exportProjectionExcel,
    exportConfigPDF, exportConfigExcel,
    exportConfigurationJSON, importConfigurationJSON
  };
})();

// ═══════════════════════════════════════════════════════════════════════════
// CONTROLADOR PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════
const App = (() => {

  let state = {
    tanks: [],
    settings: {},
    currentView: 'dashboard',
    projectionHours: 24,
    editingTankId: null,
    autoRefreshTimer: null
  };

  // ─── INICIALIZACIÓN ───────────────────────────────────────────────────
  function init() {
    loadData();
    bindNavigation();
    bindTankModal();
    bindBulkEdit();
    bindProjections();
    bindReports();
    bindSimulation();
    bindRefresh();
    startClock();
    renderCurrentView();
    startAutoRefresh();
    if (state.tanks.length === 0) loadDemoData();
  }

  function loadData() {
    const data    = Storage.load();
    state.tanks   = data.tanks    || [];
    state.settings = data.settings || {};
  }

  function saveData() {
    const data   = Storage.load();
    data.tanks   = state.tanks;
    data.settings = state.settings;
    Storage.save(data);
    const el = document.getElementById('lastUpdate');
    if (el) el.textContent = 'Actualizado: ' + new Date().toLocaleTimeString('es-CO');
  }

  function loadDemoData() {
    state.tanks = [
      {
        id: UI.generateId(), name: 'Tanque Norte T-01',
        height: 6.0, area: 150, maxInflow: 80, outflow: 45,
        currentInflow: 60, currentLevelM: 4.2, targetLevelM: 5.5,
        color: '#0ea5e9',
        alerts: {
          lowLevel:      { enabled: true, value: 30, unit: 'percent' },
          criticalLevel: { enabled: true, value: 15, unit: 'percent' }
        }
      },
      {
        id: UI.generateId(), name: 'Tanque Sur T-02',
        height: 4.5, area: 100, maxInflow: 60, outflow: 55,
        currentInflow: 40, currentLevelM: 1.8, targetLevelM: 4.0,
        color: '#f97316',
        alerts: {
          lowLevel:      { enabled: true, value: 1.5, unit: 'meters' },
          criticalLevel: { enabled: true, value: 0.8, unit: 'meters' }
        }
      },
      {
        id: UI.generateId(), name: 'Tanque Central T-03',
        height: 8.0, area: 200, maxInflow: 120, outflow: 70,
        currentInflow: 90, currentLevelM: 6.4, targetLevelM: 7.5,
        color: '#10b981',
        alerts: {
          lowLevel:      { enabled: true, value: 25, unit: 'percent' },
          criticalLevel: { enabled: true, value: 10, unit: 'percent' }
        }
      },
      {
        id: UI.generateId(), name: 'Tanque Elevado T-04',
        height: 3.0, area: 50, maxInflow: 30, outflow: 35,
        currentInflow: 20, currentLevelM: 2.1, targetLevelM: 2.8,
        color: '#8b5cf6',
        alerts: {
          lowLevel:      { enabled: true, value: 40, unit: 'percent' },
          criticalLevel: { enabled: true, value: 20, unit: 'percent' }
        }
      }
    ];
    saveData();
    renderCurrentView();
    UI.showToast('Datos de demostración cargados', 'info');
  }

  // ─── NAVEGACIÓN ───────────────────────────────────────────────────────
  function bindNavigation() {
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        navigateTo(link.dataset.view);
      });
    });

    document.getElementById('sidebarToggle').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('collapsed');
      document.getElementById('mainContent').classList.toggle('expanded');
    });
  }

  function bindSimulation() {
    // Busca un botón con id 'advanceTimeBtn' en tu HTML
    const btn = document.getElementById('advanceTimeBtn');
    if (btn) {
      btn.addEventListener('click', () => {
        const hours = 1; // Puedes hacerlo dinámico con un input
        advanceTime(hours);
      });
    }
  }

  function navigateTo(view) {
    state.currentView = view;

    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    document.querySelector(`[data-view="${view}"]`)?.classList.add('active');

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${view}`)?.classList.add('active');

    const titles = {
      dashboard:   ['Dashboard Global',       'Resumen operativo en tiempo real'],
      tanks:       ['Gestión de Tanques',      'Configuración y monitoreo individual'],
      'bulk-edit': ['Edición Masiva',          'Actualización ágil de niveles y caudales'],
      alerts:      ['Sistema de Alertas',      'Configuración y monitoreo de umbrales'],
      projections: ['Proyecciones',            'Análisis predictivo de niveles'],
      reports:     ['Reportes',                'Exportación de datos e informes']
    };

    const [title, subtitle] = titles[view] || ['Vista', ''];
    document.getElementById('pageTitle').textContent    = title;
    document.getElementById('pageSubtitle').textContent = subtitle;

    renderCurrentView();
  }

  function renderCurrentView() {
    switch (state.currentView) {
      case 'dashboard':   renderDashboard();   break;
      case 'tanks':       renderTanksList();   break;
      case 'bulk-edit':   renderBulkEdit();    break;
      case 'alerts':      renderAlerts();      break;
      case 'projections': renderProjections(); break;
      case 'reports':     renderReports();     break;
    }
    updateAlertBadge();
  }

  // ─── DASHBOARD ────────────────────────────────────────────────────────
  function renderDashboard() {
    const tanks = state.tanks;

    const totalCurrentVol = tanks.reduce((s, t) => s + Calculator.currentVolume(t), 0);
    const totalCapacity   = tanks.reduce((s, t) => s + Calculator.totalVolume(t), 0);
    const globalPct       = totalCapacity > 0 ? (totalCurrentVol / totalCapacity) * 100 : 0;
    
    const allAlerts   = tanks.flatMap(t => Calculator.evaluateAlerts(t));
    const totalInflow  = tanks.reduce((s, t) => s + (t.currentInflow || 0), 0);
    const totalOutflow = tanks.reduce((s, t) => s + (t.outflow || 0), 0);

    document.getElementById('kpiTotalTanks').textContent  = tanks.length;
    document.getElementById('kpiGlobalCapacity').textContent = `${UI.formatNumber(totalCapacity, 0)} m³`;
    document.getElementById('kpiTotalVolume').textContent    = `${UI.formatNumber(totalCurrentVol, 0)} m³`;
    document.getElementById('kpiGlobalPct').textContent      = `${UI.formatNumber(globalPct, 1)}%`;
    document.getElementById('kpiAlertCount').textContent  = allAlerts.length;
    document.getElementById('kpiTotalInflow').textContent  = `${UI.formatNumber(totalInflow, 1)} m³/h`;
    document.getElementById('kpiTotalOutflow').textContent = `${UI.formatNumber(totalOutflow, 1)} m³/h`;
    
    const healthEl = document.getElementById('kpiHealthScore');
    if (healthEl) healthEl.textContent = `${healthScore}%`;

    const alertCard = document.querySelector('.kpi-orange');
    if (alertCard) alertCard.classList.toggle('kpi-alert-active', allAlerts.length > 0);

    const hours = parseInt(document.querySelector('.chart-controls .active')?.dataset.hours || 24);
    Charts.createSystemProjectionChart('systemProjectionChart', tanks, hours);

    renderDashboardTankCards();

    document.querySelectorAll('.chart-controls .btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.chart-controls .btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        Charts.createSystemProjectionChart('systemProjectionChart', tanks, parseInt(btn.dataset.hours));
      });
    });
  }

  function renderDashboardTankCards() {
    const grid = document.getElementById('dashboardTanksGrid');
    if (!grid) return;

    if (state.tanks.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🗄️</div>
          <h3>No hay tanques configurados</h3>
          <p>Crea tu primer tanque para comenzar el monitoreo</p>
          <button class="btn btn-primary" onclick="App.openAddTankModal()">+ Agregar Tanque</button>
        </div>`;
      return;
    }

    grid.innerHTML = state.tanks.map(tank => buildTankCard(tank)).join('');

    grid.querySelectorAll('.tank-card-detail-btn').forEach(btn => {
      btn.addEventListener('click', () => openTankDetail(btn.dataset.id));
    });
    grid.querySelectorAll('.tank-card-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => openEditTankModal(btn.dataset.id));
    });
  }

  function buildTankCard(tank) {
    const pct       = Calculator.levelPercent(tank);
    const vol       = Calculator.currentVolume(tank);
    const totalVol  = Calculator.totalVolume(tank);
    const trendType = Calculator.trend(tank);
    const ttf       = Calculator.timeToFull(tank);
    const tte       = Calculator.timeToEmpty(tank);
    const net       = Calculator.netFlow(tank);
    const alerts    = Calculator.evaluateAlerts(tank);
    const levelClass  = UI.getLevelClass(pct);
    const hasCritical = alerts.some(a => a.severity === 'danger');
    const hasWarning  = alerts.some(a => a.severity === 'warning');

    const criticalTime = trendType === 'filling'
      ? `<span class="time-label">Lleno en:</span> <strong>${Calculator.formatTime(ttf)}</strong>`
      : trendType === 'draining'
      ? `<span class="time-label">Vacío en:</span> <strong>${Calculator.formatTime(tte)}</strong>`
      : `<span class="time-label">Estado:</span> <strong>Estable</strong>`;

    return `
      <div class="tank-card ${hasCritical ? 'tank-card-critical' : hasWarning ? 'tank-card-warning' : ''}"
           style="--tank-color: ${tank.color || '#0ea5e9'}">
        <div class="tank-card-header">
          <div class="tank-card-title">
            <span class="tank-color-dot" style="background:${tank.color || '#0ea5e9'}"></span>
            <h4>${tank.name}</h4>
          </div>
          <div class="tank-card-badges">
            ${alerts.length > 0
              ? `<span class="alert-dot ${hasCritical ? 'alert-dot-critical' : 'alert-dot-warning'}">⚠️ ${alerts.length}</span>`
              : ''}
            ${UI.getTrendIcon(trendType)}
          </div>
        </div>

        <div class="tank-visual">
          <div class="tank-body">
            <div class="tank-fill ${levelClass}" style="height:${pct}%; background:${tank.color || '#0ea5e9'}">
              <span class="tank-fill-label">${UI.formatNumber(pct, 1)}%</span>
            </div>
          </div>
          <div class="tank-scale">
            <span>${UI.formatNumber(tank.height, 1)}m</span>
            <span>${UI.formatNumber(tank.height * 0.75, 1)}m</span>
            <span>${UI.formatNumber(tank.height * 0.5, 1)}m</span>
            <span>${UI.formatNumber(tank.height * 0.25, 1)}m</span>
            <span>0m</span>
          </div>
        </div>

        <div class="tank-card-stats">
          <div class="stat-row">
            <span class="stat-label">Nivel actual</span>
            <span class="stat-value">${UI.formatNumber(tank.currentLevelM, 2)} m</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Volumen</span>
            <span class="stat-value">${UI.formatNumber(vol, 1)} / ${UI.formatNumber(totalVol, 1)} m³</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Entrada / Salida</span>
            <span class="stat-value">
              <span class="flow-in">↑${UI.formatNumber(tank.currentInflow || 0, 1)}</span> /
              <span class="flow-out">↓${UI.formatNumber(tank.outflow || 0, 1)}</span>
              m³/h
            </span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Caudal neto</span>
            <span class="stat-value ${net >= 0 ? 'text-green' : 'text-red'}">
              ${net >= 0 ? '+' : ''}${UI.formatNumber(net, 2)} m³/h
            </span>
          </div>
          <div class="stat-row critical-time">${criticalTime}</div>
        </div>

        <div class="tank-card-actions">
          <button class="btn btn-sm btn-outline tank-card-detail-btn" data-id="${tank.id}">
            📊 Detalle
          </button>
          <button class="btn btn-sm btn-primary tank-card-edit-btn" data-id="${tank.id}">
            ✏️ Editar
          </button>
        </div>
      </div>`;
  }

  // ─── LISTA DE TANQUES ─────────────────────────────────────────────────
  function renderTanksList() {
    const container = document.getElementById('tanksListView');
    if (!container) return;

    if (state.tanks.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🗄️</div>
          <h3>No hay tanques configurados</h3>
          <p>Crea tu primer tanque para comenzar</p>
          <button class="btn btn-primary" onclick="App.openAddTankModal()">+ Agregar Tanque</button>
        </div>`;
      return;
    }

    container.innerHTML = state.tanks.map(tank => {
      const pct       = Calculator.levelPercent(tank);
      const vol       = Calculator.currentVolume(tank);
      const totalVol  = Calculator.totalVolume(tank);
      const trendType = Calculator.trend(tank);
      const ttf       = Calculator.timeToFull(tank);
      const tte       = Calculator.timeToEmpty(tank);
      const alerts    = Calculator.evaluateAlerts(tank);

      return `
        <div class="tank-list-item card">
          <div class="tank-list-header">
            <div class="tank-list-title">
              <span class="tank-color-dot lg" style="background:${tank.color || '#0ea5e9'}"></span>
              <div>
                <h3>${tank.name}</h3>
                <span class="tank-id">ID: ${tank.id}</span>
              </div>
            </div>
            <div class="tank-list-badges">
              ${alerts.length > 0
                ? `<span class="badge badge-red">⚠️ ${alerts.length} alertas</span>`
                : '<span class="badge badge-green">✅ Normal</span>'}
              ${UI.getTrendIcon(trendType)}
            </div>
          </div>

          <div class="tank-list-body">
            <div class="tank-list-progress">
              <div class="progress-bar-container">
                <div class="progress-bar" style="width:${pct}%; background:${tank.color || '#0ea5e9'}">
                  <span>${UI.formatNumber(pct, 1)}%</span>
                </div>
              </div>
              <div class="progress-labels">
                <span>0%</span>
                <span>${UI.formatNumber(tank.currentLevelM, 2)}m / ${UI.formatNumber(tank.height, 2)}m</span>
                <span>100%</span>
              </div>
            </div>

            <div class="tank-list-specs">
              <div class="spec-item">
                <span class="spec-label">Área Base</span>
                <span class="spec-value">${tank.area} m²</span>
              </div>
              <div class="spec-item">
                <span class="spec-label">Volumen Actual</span>
                <span class="spec-value">${UI.formatNumber(vol, 1)} m³</span>
              </div>
              <div class="spec-item">
                <span class="spec-label">Capacidad Total</span>
                <span class="spec-value">${UI.formatNumber(totalVol, 1)} m³</span>
              </div>
              <div class="spec-item">
                <span class="spec-label">Caudal Entrada</span>
                <span class="spec-value text-green">↑ ${UI.formatNumber(tank.currentInflow || 0, 2)} m³/h</span>
              </div>
              <div class="spec-item">
                <span class="spec-label">Caudal Salida</span>
                <span class="spec-value text-red">↓ ${UI.formatNumber(tank.outflow || 0, 2)} m³/h</span>
              </div>
              <div class="spec-item">
                <span class="spec-label">Tiempo hasta Lleno</span>
                <span class="spec-value">${Calculator.formatTime(ttf)}</span>
              </div>
              <div class="spec-item">
                <span class="spec-label">Tiempo hasta Vacío</span>
                <span class="spec-value">${Calculator.formatTime(tte)}</span>
              </div>
              <div class="spec-item">
                <span class="spec-label">Nivel Objetivo</span>
                <span class="spec-value">${tank.targetLevelM ? UI.formatNumber(tank.targetLevelM, 2) + 'm' : '—'}</span>
              </div>
            </div>
          </div>

          <div class="tank-list-actions">
            <button class="btn btn-sm btn-outline" onclick="App.openTankDetail('${tank.id}')">📊 Detalle</button>
            <button class="btn btn-sm btn-primary"  onclick="App.openEditTankModal('${tank.id}')">✏️ Editar</button>
            <button class="btn btn-sm btn-danger"   onclick="App.deleteTank('${tank.id}')">🗑️ Eliminar</button>
          </div>
        </div>`;
    }).join('');
  }

  // ─── MODAL TANQUE ─────────────────────────────────────────────────────
  function bindTankModal() {
    const modal = document.getElementById('tankModal');

    document.getElementById('addTankBtn').addEventListener('click', openAddTankModal);
    document.getElementById('addTankBtn2')?.addEventListener('click', openAddTankModal);
    document.getElementById('closeTankModal').addEventListener('click', closeTankModal);
    document.getElementById('cancelTankModal').addEventListener('click', closeTankModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeTankModal(); });
    document.getElementById('saveTankBtn').addEventListener('click', saveTank);

    ['tankHeight', 'tankArea'].forEach(id => {
      document.getElementById(id).addEventListener('input', updateCalcVolume);
    });

    document.getElementById('tankHeight').addEventListener('input', function () {
      updateCalcVolume();
    });
  }

  function updateCalcVolume() {
    const h = parseFloat(document.getElementById('tankHeight').value) || 0;
    const a = parseFloat(document.getElementById('tankArea').value)   || 0;
    document.getElementById('calcVolume').textContent = `${UI.formatNumber(h * a, 2)} m³`;
  }

  function openAddTankModal() {
    state.editingTankId = null;
    document.getElementById('modalTitle').textContent = 'Nuevo Tanque';
    document.getElementById('tankForm').reset();
    document.getElementById('tankId').value    = '';
    document.getElementById('calcVolume').textContent = '0.00 m³';
    document.getElementById('tankColor').value = '#0ea5e9';
    document.getElementById('tankModal').classList.add('active');
  }

  function openEditTankModal(id) {
    const tank = state.tanks.find(t => t.id === id);
    if (!tank) return;

    state.editingTankId = id;
    document.getElementById('modalTitle').textContent = `Editar: ${tank.name}`;
    document.getElementById('tankId').value            = tank.id;
    document.getElementById('tankName').value          = tank.name;
    document.getElementById('tankHeight').value        = tank.height;
    document.getElementById('tankArea').value          = tank.area;
    document.getElementById('tankMaxInflow').value     = tank.maxInflow;
    document.getElementById('tankOutflow').value       = tank.outflow;
    document.getElementById('tankColor').value = tank.color || '#0ea5e9';
    updateCalcVolume();
    document.getElementById('tankModal').classList.add('active');
  }

  function closeTankModal() {
    document.getElementById('tankModal').classList.remove('active');
    state.editingTankId = null;
  }

  function saveTank() {
    const name          = document.getElementById('tankName').value.trim();
    const height        = parseFloat(document.getElementById('tankHeight').value);
    const area          = parseFloat(document.getElementById('tankArea').value);
    const maxInflow     = parseFloat(document.getElementById('tankMaxInflow').value);
    const outflow       = parseFloat(document.getElementById('tankOutflow').value);
    const color         = document.getElementById('tankColor').value;

    if (!name)                          { UI.showToast('El nombre es requerido', 'error'); return; }
    if (isNaN(height) || height <= 0)   { UI.showToast('La altura debe ser > 0', 'error'); return; }
    if (isNaN(area)   || area   <= 0)   { UI.showToast('El área debe ser > 0',   'error'); return; }
    if (isNaN(maxInflow) || maxInflow < 0) { UI.showToast('Caudal entrada inválido', 'error'); return; }
    if (isNaN(outflow)   || outflow   < 0) { UI.showToast('Caudal salida inválido',  'error'); return; }

    if (state.editingTankId) {
      const idx = state.tanks.findIndex(t => t.id === state.editingTankId);
      if (idx !== -1) {
        // Solo actualizamos los campos físicos y básicos
        state.tanks[idx].name = name;
        state.tanks[idx].height = height;
        state.tanks[idx].area = area;
        state.tanks[idx].maxInflow = maxInflow;
        state.tanks[idx].outflow = outflow;
        state.tanks[idx].color = color;
        
        // Ajustar nivel actual si la nueva altura es menor
        if (state.tanks[idx].currentLevelM > height) {
          state.tanks[idx].currentLevelM = height;
        }
        // Ajustar nivel objetivo si la nueva altura es menor
        if (state.tanks[idx].targetLevelM && state.tanks[idx].targetLevelM > height) {
          state.tanks[idx].targetLevelM = height;
        }
        UI.showToast(`Tanque "${name}" actualizado`, 'success');
      }
    } else {
      const newTank = {
        id: UI.generateId(),
        name, height, area, maxInflow, outflow, color,
        currentInflow: 0,
        currentLevelM: 0,
        targetLevelM: null,
        alerts: {
          lowLevel:      { enabled: false, value: 20, unit: 'percent' },
          criticalLevel: { enabled: false, value: 10, unit: 'percent' }
        }
      };
      state.tanks.push(newTank);
      UI.showToast(`Tanque "${name}" creado`, 'success');
    }

    saveData();
    closeTankModal();
    renderCurrentView();
  }

  function advanceTime(hours) {
    state.tanks = state.tanks.map(tank => {
      const newLevel = Calculator.projectLevel(tank, hours);
      return { ...tank, currentLevelM: parseFloat(newLevel.toFixed(4)) };
    });
    saveData();
    renderCurrentView();
    UI.showToast(`Simulación: se ha avanzado ${hours}h de operación`, 'info');
  }

  // ─── ELIMINAR TANQUE ──────────────────────────────────────────────────
  async function deleteTank(id) {
    const tank = state.tanks.find(t => t.id === id);
    if (!tank) return;
    const confirmed = await UI.confirm(`¿Eliminar el tanque "${tank.name}"? Esta acción no se puede deshacer.`);
    if (confirmed) {
      state.tanks = state.tanks.filter(t => t.id !== id);
      saveData();
      renderCurrentView();
      UI.showToast(`Tanque "${tank.name}" eliminado`, 'warning');
    }
  }

  // ─── DETALLE DE TANQUE ────────────────────────────────────────────────
  function openTankDetail(id) {
    const tank = state.tanks.find(t => t.id === id);
    if (!tank) return;

    const pct       = Calculator.levelPercent(tank);
    const vol       = Calculator.currentVolume(tank);
    const totalVol  = Calculator.totalVolume(tank);
    const trendType = Calculator.trend(tank);
    const ttf       = Calculator.timeToFull(tank);
    const tte       = Calculator.timeToEmpty(tank);
    const net       = Calculator.netFlow(tank);
    const alerts    = Calculator.evaluateAlerts(tank);
    const proj12    = Calculator.projectLevel(tank, 12);
    const proj24    = Calculator.projectLevel(tank, 24);
    const proj12Pct = Math.min(100, Math.max(0, (proj12 / tank.height) * 100));
    const proj24Pct = Math.min(100, Math.max(0, (proj24 / tank.height) * 100));
    const reqInflow = Calculator.requiredInflow(tank, 12); // Para llegar al objetivo en 12h

    document.getElementById('detailModalTitle').textContent = `📊 ${tank.name}`;
    document.getElementById('tankDetailBody').innerHTML = `
      <div class="detail-grid">
        <div class="detail-section">
          <h4>Estado Actual</h4>
          <div class="detail-level-visual">
            <div class="detail-tank-body">
              <div class="detail-tank-fill" style="height:${pct}%; background:${tank.color}">
                <span>${UI.formatNumber(pct, 1)}%</span>
              </div>
            </div>
            <div class="detail-level-info">
              <div class="detail-stat">
                <span class="detail-stat-label">Nivel</span>
                <span class="detail-stat-value">${UI.formatNumber(tank.currentLevelM, 3)} m</span>
              </div>
              <div class="detail-stat">
                <span class="detail-stat-label">Porcentaje</span>
                <span class="detail-stat-value">${UI.formatNumber(pct, 2)}%</span>
              </div>
              <div class="detail-stat">
                <span class="detail-stat-label">Volumen actual</span>
                <span class="detail-stat-value">${UI.formatNumber(vol, 2)} m³</span>
              </div>
              <div class="detail-stat">
                <span class="detail-stat-label">Capacidad total</span>
                <span class="detail-stat-value">${UI.formatNumber(totalVol, 2)} m³</span>
              </div>
              <div class="detail-stat">
                <span class="detail-stat-label">Tendencia</span>
                <span class="detail-stat-value">${UI.getTrendIcon(trendType)}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="detail-section">
          <h4>Caudales</h4>
          <div class="detail-flows">
            <div class="flow-card flow-in">
              <div class="flow-icon">⬆️</div>
              <div class="flow-value">${UI.formatNumber(tank.currentInflow || 0, 2)}</div>
              <div class="flow-unit">m³/h Entrada</div>
              <div class="flow-max">Máx: ${UI.formatNumber(tank.maxInflow, 2)} m³/h</div>
            </div>
            <div class="flow-card flow-net ${net >= 0 ? 'flow-net-pos' : 'flow-net-neg'}">
              <div class="flow-icon">${net >= 0 ? '📈' : '📉'}</div>
              <div class="flow-value">${net >= 0 ? '+' : ''}${UI.formatNumber(net, 2)}</div>
              <div class="flow-unit">m³/h Neto</div>
            </div>
            <div class="flow-card flow-out">
              <div class="flow-icon">⬇️</div>
              <div class="flow-value">${UI.formatNumber(tank.outflow || 0, 2)}</div>
              <div class="flow-unit">m³/h Salida</div>
            </div>
          </div>
        </div>

        <div class="detail-section">
          <h4>Recomendación Operativa</h4>
          <div class="recommendation-card">
            <p>Para alcanzar el nivel objetivo (${tank.targetLevelM}m) en 12 horas, configure:</p>
            <strong>${reqInflow ? UI.formatNumber(reqInflow, 2) + ' m³/h' : 'N/A'}</strong>
          </div>
        </div>

        <div class="detail-section">
          <h4>Tiempos Críticos</h4>
          <div class="critical-times">
            <div class="critical-time-card ${ttf !== null && ttf < 2 ? 'critical-urgent' : ''}">
              <div class="ct-icon">🔴</div>
              <div class="ct-label">Tiempo hasta REBOSE</div>
              <div class="ct-value">${Calculator.formatTime(ttf)}</div>
            </div>
            <div class="critical-time-card ${tte !== null && tte < 2 ? 'critical-urgent' : ''}">
              <div class="ct-icon">🟡</div>
              <div class="ct-label">Tiempo hasta VACIADO</div>
              <div class="ct-value">${Calculator.formatTime(tte)}</div>
            </div>
          </div>
        </div>

        <div class="detail-section">
          <h4>Proyecciones</h4>
          <div class="projection-cards">
            <div class="proj-card">
              <div class="proj-label">En 12 horas</div>
              <div class="proj-value">${UI.formatNumber(proj12, 2)} m</div>
              <div class="proj-pct">${UI.formatNumber(proj12Pct, 1)}%</div>
            </div>
            <div class="proj-card">
              <div class="proj-label">En 24 horas</div>
              <div class="proj-value">${UI.formatNumber(proj24, 2)} m</div>
              <div class="proj-pct">${UI.formatNumber(proj24Pct, 1)}%</div>
            </div>
          </div>
        </div>

        ${alerts.length > 0 ? `
        <div class="detail-section detail-alerts">
          <h4>⚠️ Alertas Activas (${alerts.length})</h4>
          ${alerts.map(a => `
            <div class="alert-item alert-${a.severity}">
              <span>${a.message}</span>
            </div>`).join('')}
        </div>` : ''}

        <div class="detail-section">
          <h4>Especificaciones</h4>
          <div class="specs-grid">
            <div class="spec-row"><span>Altura total</span><strong>${tank.height} m</strong></div>
            <div class="spec-row"><span>Área base</span><strong>${tank.area} m²</strong></div>
            <div class="spec-row"><span>Nivel objetivo</span><strong>${tank.targetLevelM ? tank.targetLevelM + ' m' : '—'}</strong></div>
          </div>
        </div>
      </div>`;

    document.getElementById('tankDetailModal').classList.add('active');
    document.getElementById('closeDetailModal').onclick = () =>
      document.getElementById('tankDetailModal').classList.remove('active');
    document.getElementById('tankDetailModal').onclick = e => {
      if (e.target === document.getElementById('tankDetailModal'))
        document.getElementById('tankDetailModal').classList.remove('active');
    };
  }

  // ─── EDICIÓN MASIVA ───────────────────────────────────────────────────
  function bindBulkEdit() {
    document.getElementById('saveBulkBtn').addEventListener('click', saveBulkEdit);
    document.getElementById('resetBulkBtn').addEventListener('click', () => {
      renderBulkEdit();
      UI.showToast('Cambios descartados', 'info');
    });
  }

  function renderBulkEdit() {
    const tbody = document.getElementById('bulkEditBody');
    if (!tbody) return;

    if (state.tanks.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">No hay tanques configurados</td></tr>`;
      return;
    }

    tbody.innerHTML = state.tanks.map(tank => {
      const pct       = Calculator.levelPercent(tank);
      const trendType = Calculator.trend(tank);
      const ttf       = Calculator.timeToFull(tank);
      const tte       = Calculator.timeToEmpty(tank);
      const criticalTime = trendType === 'filling'
        ? Calculator.formatTime(ttf)
        : trendType === 'draining'
        ? Calculator.formatTime(tte)
        : '—';

      return `
        <tr data-id="${tank.id}">

          <!-- Nombre -->
          <td>
            <div class="bulk-tank-name">
              <span class="tank-color-dot" style="background:${tank.color || '#0ea5e9'}"></span>
              <div>
                <strong>${tank.name}</strong>
                <div class="bulk-tank-meta">H: ${tank.height}m · A: ${tank.area}m²</div>
              </div>
            </div>
          </td>

          <!-- Nivel actual — bidireccional metros ↔ porcentaje -->
          <td>
            <div class="bulk-level-editor">
              <div class="bulk-level-bar-wrap">
                <div class="bulk-level-bar-track">
                  <div class="bulk-level-bar-fill"
                       data-id="${tank.id}"
                       style="width:${pct}%; background:${tank.color || '#0ea5e9'}">
                  </div>
                </div>
              </div>
              <div class="bulk-dual-inputs">
                <div class="bulk-dual-field">
                  <input type="number"
                         class="form-control form-control-sm bulk-level-m"
                         data-id="${tank.id}"
                         data-height="${tank.height}"
                         value="${tank.currentLevelM.toFixed(3)}"
                         min="0"
                         max="${tank.height}"
                         step="0.001"
                         title="Nivel en metros (máx: ${tank.height} m)"/>
                  <span class="bulk-field-unit">m</span>
                </div>
                <span class="bulk-dual-sep">↔</span>
                <div class="bulk-dual-field">
                  <input type="number"
                         class="form-control form-control-sm bulk-level-pct"
                         data-id="${tank.id}"
                         data-height="${tank.height}"
                         value="${pct.toFixed(2)}"
                         min="0"
                         max="100"
                         step="0.01"
                         title="Nivel en porcentaje"/>
                  <span class="bulk-field-unit">%</span>
                </div>
              </div>
            </div>
          </td>

          <!-- Nivel Objetivo -->
          <td>
            <div class="bulk-dual-inputs">
              <div class="bulk-dual-field">
                <input type="number"
                       class="form-control form-control-sm bulk-target-m"
                       data-id="${tank.id}"
                       data-height="${tank.height}"
                       value="${tank.targetLevelM !== null ? tank.targetLevelM.toFixed(3) : ''}"
                       min="0"
                       max="${tank.height}"
                       step="0.001"
                       placeholder="Meta m"/>
                <span class="bulk-field-unit">m</span>
              </div>
              <span class="bulk-dual-sep">↔</span>
              <div class="bulk-dual-field">
                <input type="number"
                       class="form-control form-control-sm bulk-target-pct"
                       data-id="${tank.id}"
                       data-height="${tank.height}"
                       value="${tank.targetLevelM !== null ? ((tank.targetLevelM / tank.height) * 100).toFixed(2) : ''}"
                       min="0"
                       max="100"
                       step="0.01"
                       placeholder="%"/>
                <span class="bulk-field-unit">%</span>
              </div>
            </div>
          </td>

          <!-- Tendencia -->
          <td class="bulk-trend-cell" data-id="${tank.id}">
            ${UI.getTrendIcon(trendType)}
          </td>

          <!-- Caudal entrada -->
          <td>
            <div class="bulk-input-group">
              <input type="number"
                     class="form-control bulk-inflow"
                     data-id="${tank.id}"
                     value="${(tank.currentInflow || 0).toFixed(1)}"
                     min="0"
                     max="${tank.maxInflow}"
                     step="0.1"
                     title="Máx permitido: ${tank.maxInflow} m³/h"/>
              <span class="bulk-input-max">/ ${tank.maxInflow}</span>
            </div>
          </td>

          <!-- Caudal salida -->
          <td>
            <input type="number"
                   class="form-control bulk-outflow"
                   data-id="${tank.id}"
                   value="${(tank.outflow || 0).toFixed(1)}"
                   min="0"
                   step="0.1"/>
          </td>

          <!-- Tiempo crítico -->
          <td>
            <span class="critical-time-badge bulk-critical-badge
                         ${trendType === 'draining' ? 'badge-warning'
                           : trendType === 'filling' ? 'badge-info'
                           : 'badge-neutral'}"
                  data-id="${tank.id}">
              ${criticalTime}
            </span>
          </td>

        </tr>`;
    }).join('');

    // ── Bind: metros → porcentaje ──────────────────────────────────────
    tbody.querySelectorAll('.bulk-level-m').forEach(input => {
      input.addEventListener('input', function () {
        const id     = this.dataset.id;
        const height = parseFloat(this.dataset.height) || 0;
        let m        = parseFloat(this.value);
        if (!isNaN(m) && height > 0) {
          if (m > height) { m = height; this.value = m; }
          if (m < 0) { m = 0; this.value = 0; }
          const pctVal  = (m / height) * 100;
          const pctInput = tbody.querySelector(`.bulk-level-pct[data-id="${id}"]`);
          if (pctInput) pctInput.value = pctVal.toFixed(2);
          updateBulkLevelBar(id, pctVal, tbody);
        }
        updateBulkRowPreview(id, tbody);
      });
    });

    // ── Bind: porcentaje → metros ──────────────────────────────────────
    tbody.querySelectorAll('.bulk-level-pct').forEach(input => {
      input.addEventListener('input', function () {
        const id     = this.dataset.id;
        const height = parseFloat(this.dataset.height) || 0;
        let pctVal   = parseFloat(this.value);
        if (!isNaN(pctVal) && height > 0) {
          if (pctVal > 100) { pctVal = 100; this.value = 100; }
          if (pctVal < 0)   { pctVal = 0;   this.value = 0; }
          const mVal   = (pctVal / 100) * height;
          const mInput = tbody.querySelector(`.bulk-level-m[data-id="${id}"]`);
          if (mInput) mInput.value = mVal.toFixed(3);
          updateBulkLevelBar(id, pctVal, tbody);
        }
        updateBulkRowPreview(id, tbody);
      });
    });

    // ── Bind: Objetivo metros → porcentaje ────────────────────────────
    tbody.querySelectorAll('.bulk-target-m').forEach(input => {
      input.addEventListener('input', function () {
        const id     = this.dataset.id;
        const height = parseFloat(this.dataset.height) || 0;
        let m        = parseFloat(this.value);
        if (!isNaN(m) && height > 0) {
          if (m > height) { m = height; this.value = m; }
          if (m < 0) { m = 0; this.value = 0; }
          const pctVal = (m / height) * 100;
          const pctInput = tbody.querySelector(`.bulk-target-pct[data-id="${id}"]`);
          if (pctInput) pctInput.value = pctVal.toFixed(2);
        }
        updateBulkRowPreview(id, tbody);
      });
    });

    // ── Bind: Objetivo porcentaje → metros ────────────────────────────
    tbody.querySelectorAll('.bulk-target-pct').forEach(input => {
      input.addEventListener('input', function () {
        const id     = this.dataset.id;
        const height = parseFloat(this.dataset.height) || 0;
        let pctVal   = parseFloat(this.value);
        if (!isNaN(pctVal) && height > 0) {
          if (pctVal > 100) { pctVal = 100; this.value = 100; }
          if (pctVal < 0)   { pctVal = 0;   this.value = 0; }
          const mVal = (pctVal / 100) * height;
          const mInput = tbody.querySelector(`.bulk-target-m[data-id="${id}"]`);
          if (mInput) mInput.value = mVal.toFixed(3);
        }
        updateBulkRowPreview(id, tbody);
      });
    });

    // ── Bind: caudales → preview en tiempo real ────────────────────────
    tbody.querySelectorAll('.bulk-inflow, .bulk-outflow').forEach(input => {
      input.addEventListener('input', function () {
        updateBulkRowPreview(this.dataset.id, tbody);
      });
    });
  }

  function updateBulkLevelBar(id, pct, tbody) {
    const fill = tbody
      ? tbody.querySelector(`.bulk-level-bar-fill[data-id="${id}"]`)
      : document.querySelector(`#bulkEditBody .bulk-level-bar-fill[data-id="${id}"]`);
    if (!fill) return;

    const clampedPct = Math.min(100, Math.max(0, pct));
    fill.style.width = clampedPct + '%';

    if      (clampedPct >= 80) fill.style.background = '#10b981';
    else if (clampedPct >= 40) fill.style.background = '#0ea5e9';
    else if (clampedPct >= 20) fill.style.background = '#f97316';
    else                       fill.style.background = '#ef4444';
  }

  function updateBulkRowPreview(id, tbody) {
    const resolvedTbody = tbody || document.getElementById('bulkEditBody');
    const row  = resolvedTbody.querySelector(`tr[data-id="${id}"]`);
    if (!row) return;

    const tank = state.tanks.find(t => t.id === id);
    if (!tank) return;

    const inflow  = parseFloat(row.querySelector('.bulk-inflow').value)  || 0;
    const outflow = parseFloat(row.querySelector('.bulk-outflow').value) || 0;
    const levelM  = parseFloat(row.querySelector('.bulk-level-m').value);
    const targetM = parseFloat(row.querySelector('.bulk-target-m').value);
    
    const resolvedLevelM = isNaN(levelM) ? tank.currentLevelM : levelM;
    const resolvedTargetM = isNaN(targetM) ? null : targetM;

    const tempTank = { ...tank, currentInflow: inflow, outflow, currentLevelM: resolvedLevelM, targetLevelM: resolvedTargetM };

    const trendType    = Calculator.trend(tempTank);
    const ttf          = Calculator.timeToFull(tempTank);
    const ttt          = Calculator.timeToTarget(tempTank);
    const tte          = Calculator.timeToEmpty(tempTank);

    const criticalTime = trendType === 'filling'
      ? (ttt !== null 
          ? `${Calculator.formatTime(ttt)} (a meta)` 
          : Calculator.formatTime(ttf))
      : trendType === 'draining'
      ? Calculator.formatTime(tte)
      : '—';

    const trendCell = row.querySelector('.bulk-trend-cell');
    if (trendCell) trendCell.innerHTML = UI.getTrendIcon(trendType);

    const badge = row.querySelector('.bulk-critical-badge');
    if (badge) {
      badge.textContent = criticalTime;
      badge.className   = `critical-time-badge bulk-critical-badge
        ${trendType === 'draining' ? 'badge-warning'
          : trendType === 'filling' ? 'badge-info'
          : 'badge-neutral'}`;
    }
  }

  function saveBulkEdit() {
    let changes = 0;
    const errors = [];

    document.querySelectorAll('#bulkEditBody tr[data-id]').forEach(row => {
      const id   = row.dataset.id;
      const tank = state.tanks.find(t => t.id === id);
      if (!tank) return;

      const inflow  = parseFloat(row.querySelector('.bulk-inflow').value);
      const outflow = parseFloat(row.querySelector('.bulk-outflow').value);
      const levelM  = parseFloat(row.querySelector('.bulk-level-m').value);
      const targetM = parseFloat(row.querySelector('.bulk-target-m').value);

      if (isNaN(inflow) || inflow < 0) {
        errors.push(`"${tank.name}": caudal de entrada inválido`); return;
      }
      const targetVal = isNaN(targetM) ? null : parseFloat(targetM.toFixed(4));

      if (inflow > tank.maxInflow) {
        errors.push(`"${tank.name}": entrada ${inflow} supera el máximo ${tank.maxInflow} m³/h`); return;
      }
      if (isNaN(outflow) || outflow < 0) {
        errors.push(`"${tank.name}": caudal de salida inválido`); return;
      }
      if (isNaN(levelM) || levelM < 0) {
        errors.push(`"${tank.name}": nivel actual inválido`); return;
      }
      if (levelM > tank.height) {
        errors.push(`"${tank.name}": nivel ${levelM}m supera la altura total ${tank.height}m`); return;
      }
      if (targetVal !== null && targetVal > tank.height) {
        errors.push(`"${tank.name}": nivel objetivo ${targetVal}m supera la altura total ${tank.height}m`); return;
      }

      const changed =
        tank.currentInflow !== inflow  ||
        tank.outflow       !== outflow ||
        tank.currentLevelM !== levelM ||
        tank.targetLevelM  !== targetVal;

      if (changed) {
        tank.currentInflow = inflow;
        tank.outflow       = outflow;
        tank.targetLevelM  = targetVal;
        tank.currentLevelM = parseFloat(levelM.toFixed(4));
        changes++;
      }
    });

    if (errors.length > 0) {
      UI.showToast(errors.join(' | '), 'error', 7000);
      return;
    }

    if (changes === 0) {
      UI.showToast('No se detectaron cambios para guardar', 'info');
      return;
    }

    saveData();
    renderBulkEdit();
    updateAlertBadge();

    if (state.currentView === 'dashboard') renderDashboard();

    const statusEl = document.getElementById('bulkStatus');
    if (statusEl) {
      statusEl.textContent = `✅ ${changes} tanque(s) actualizado(s) — ${new Date().toLocaleTimeString('es-CO')}`;
      statusEl.style.color = '#10b981';
    }

    UI.showToast(`${changes} tanque(s) actualizados correctamente`, 'success');
  }

  // ─── ALERTAS ──────────────────────────────────────────────────────────
  function renderAlerts() {
    renderAlertsConfig();
    renderActiveAlerts();
  }

  function renderAlertsConfig() {
    const container = document.getElementById('alertsConfigList');
    if (!container) return;

    if (state.tanks.length === 0) {
      container.innerHTML = '<p class="empty-text">No hay tanques configurados</p>';
      return;
    }

    container.innerHTML = state.tanks.map(tank => {
      const low      = tank.alerts?.lowLevel      || { enabled: false, value: 20, unit: 'percent' };
      const critical = tank.alerts?.criticalLevel || { enabled: false, value: 10, unit: 'percent' };

      return `
        <div class="alert-config-item" data-id="${tank.id}">
          <div class="alert-config-header">
            <span class="tank-color-dot" style="background:${tank.color || '#0ea5e9'}"></span>
            <strong>${tank.name}</strong>
          </div>

          <div class="alert-threshold-row">
            <label class="toggle-label">
              <input type="checkbox" class="alert-toggle"
                     data-id="${tank.id}" data-type="lowLevel"
                     ${low.enabled ? 'checked' : ''}/>
              <span class="toggle-slider"></span>
              Nivel Bajo
            </label>
            <div class="threshold-inputs">
              <input type="number" class="form-control form-control-sm alert-value"
                     data-id="${tank.id}" data-type="lowLevel"
                     value="${low.value}" min="0" step="0.1"/>
              <select class="form-control form-control-sm alert-unit"
                      data-id="${tank.id}" data-type="lowLevel">
                <option value="percent" ${low.unit === 'percent' ? 'selected' : ''}>%</option>
                <option value="meters"  ${low.unit === 'meters'  ? 'selected' : ''}>m</option>
              </select>
            </div>
          </div>

          <div class="alert-threshold-row">
            <label class="toggle-label">
              <input type="checkbox" class="alert-toggle"
                     data-id="${tank.id}" data-type="criticalLevel"
                     ${critical.enabled ? 'checked' : ''}/>
              <span class="toggle-slider"></span>
              Nivel Crítico
            </label>
            <div class="threshold-inputs">
              <input type="number" class="form-control form-control-sm alert-value"
                     data-id="${tank.id}" data-type="criticalLevel"
                     value="${critical.value}" min="0" step="0.1"/>
              <select class="form-control form-control-sm alert-unit"
                      data-id="${tank.id}" data-type="criticalLevel">
                <option value="percent" ${critical.unit === 'percent' ? 'selected' : ''}>%</option>
                <option value="meters"  ${critical.unit === 'meters'  ? 'selected' : ''}>m</option>
              </select>
            </div>
          </div>

          <button class="btn btn-sm btn-primary save-alert-btn" data-id="${tank.id}">
            💾 Guardar Umbrales
          </button>
        </div>`;
    }).join('');

    container.querySelectorAll('.save-alert-btn').forEach(btn => {
      btn.addEventListener('click', () => saveAlertConfig(btn.dataset.id));
    });
  }

  function saveAlertConfig(tankId) {
    const tank = state.tanks.find(t => t.id === tankId);
    if (!tank) return;

    const getConfig = (type) => ({
      enabled: document.querySelector(`.alert-toggle[data-id="${tankId}"][data-type="${type}"]`)?.checked || false,
      value:   parseFloat(document.querySelector(`.alert-value[data-id="${tankId}"][data-type="${type}"]`)?.value) || 0,
      unit:    document.querySelector(`.alert-unit[data-id="${tankId}"][data-type="${type}"]`)?.value || 'percent'
    });

    tank.alerts = {
      lowLevel:      getConfig('lowLevel'),
      criticalLevel: getConfig('criticalLevel')
    };

    saveData();
    renderActiveAlerts();
    updateAlertBadge();
    UI.showToast(`Umbrales de "${tank.name}" guardados`, 'success');
  }

  function renderActiveAlerts() {
    const container = document.getElementById('activeAlertsList');
    if (!container) return;

    const allAlerts = state.tanks.flatMap(t => Calculator.evaluateAlerts(t));
    const countEl   = document.getElementById('activeAlertsCount');
    if (countEl) countEl.textContent = allAlerts.length;

    if (allAlerts.length === 0) {
      container.innerHTML = `
        <div class="no-alerts">
          <span class="no-alerts-icon">✅</span>
          <p>No hay alertas activas. Todos los tanques operan normalmente.</p>
        </div>`;
      return;
    }

    container.innerHTML = allAlerts.map(alert => `
      <div class="active-alert-item alert-${alert.severity}">
        <div class="alert-item-header">
          <strong>${alert.tank}</strong>
          <span class="alert-type-badge ${alert.severity}">${alert.type.toUpperCase()}</span>
        </div>
        <p>${alert.message}</p>
        <span class="alert-time">${new Date().toLocaleTimeString('es-CO')}</span>
      </div>`).join('');
  }

  function updateAlertBadge() {
    const count  = state.tanks.flatMap(t => Calculator.evaluateAlerts(t)).length;
    const badge  = document.getElementById('alertBadge');
    if (badge) {
      badge.textContent    = count;
      badge.style.display  = count > 0 ? 'inline-flex' : 'none';
    }
    const kpiEl = document.getElementById('kpiAlertCount');
    if (kpiEl) kpiEl.textContent = count;
  }

  // ─── PROYECCIONES ─────────────────────────────────────────────────────
  function bindProjections() {
    document.getElementById('updateProjectionBtn').addEventListener('click', renderProjections);
    document.getElementById('projectionTankSelect').addEventListener('change', renderProjections);
    document.getElementById('projectionHorizon').addEventListener('change', renderProjections);
  }

  function renderProjections() {
    updateProjectionTankSelect();
    const tankId      = document.getElementById('projectionTankSelect')?.value || 'all';
    const hours       = parseInt(document.getElementById('projectionHorizon')?.value || 24);
    const cutoffTime  = document.getElementById('cutoffTime')?.value || '06:00';

    const tanksToProject = tankId === 'all'
      ? state.tanks
      : state.tanks.filter(t => t.id === tankId);

    if (tanksToProject.length === 0) {
      document.getElementById('projectionKpis').innerHTML =
        '<p class="empty-text">No hay tanques para proyectar</p>';
      return;
    }

    renderProjectionKPIs(tanksToProject, cutoffTime, hours);

    const tanksData = tanksToProject.map(tank => ({
      tank,
      points: Calculator.generateProjectionPoints(tank, hours, 25)
    }));

    document.getElementById('projectionChartTitle').textContent =
      `Proyección de Niveles — ${hours} horas (${tankId === 'all' ? 'Todos los tanques' : tanksToProject[0]?.name})`;

    Charts.createProjectionChart('projectionChart', tanksData, hours);
    renderProjectionTable(tanksToProject, hours);
  }

  function updateProjectionTankSelect() {
    const select  = document.getElementById('projectionTankSelect');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="all">Todos los tanques</option>' +
      state.tanks.map(t =>
        `<option value="${t.id}" ${t.id === current ? 'selected' : ''}>${t.name}</option>`
      ).join('');
  }

  function renderProjectionKPIs(tanks, cutoffTime, hours) {
    const container = document.getElementById('projectionKpis');
    if (!container) return;

    container.innerHTML = tanks.map(tank => {
      const pct       = Calculator.levelPercent(tank);
      const trendType = Calculator.trend(tank);
      const ttf       = Calculator.timeToFull(tank);
      const tte       = Calculator.timeToEmpty(tank);
      const atCutoff  = Calculator.projectAtTime(tank, cutoffTime);
      const proj12    = Calculator.projectLevel(tank, 12);
      const proj24    = Calculator.projectLevel(tank, 24);
      const proj12Pct = Math.min(100, Math.max(0, (proj12 / tank.height) * 100));
      const proj24Pct = Math.min(100, Math.max(0, (proj24 / tank.height) * 100));

      return `
        <div class="proj-kpi-card" style="border-top: 3px solid ${tank.color || '#0ea5e9'}">
          <div class="proj-kpi-header">
            <span class="tank-color-dot" style="background:${tank.color || '#0ea5e9'}"></span>
            <strong>${tank.name}</strong>
            ${UI.getTrendIcon(trendType)}
          </div>
          <div class="proj-kpi-grid">
            <div class="proj-kpi-item">
              <span class="proj-kpi-label">Nivel Actual</span>
              <span class="proj-kpi-value">${UI.formatNumber(pct, 1)}%</span>
              <span class="proj-kpi-sub">${UI.formatNumber(tank.currentLevelM, 2)} m</span>
            </div>
            <div class="proj-kpi-item">
              <span class="proj-kpi-label">En 12h</span>
              <span class="proj-kpi-value">${UI.formatNumber(proj12Pct, 1)}%</span>
              <span class="proj-kpi-sub">${UI.formatNumber(proj12, 2)} m</span>
            </div>
            <div class="proj-kpi-item">
              <span class="proj-kpi-label">En 24h</span>
              <span class="proj-kpi-value">${UI.formatNumber(proj24Pct, 1)}%</span>
              <span class="proj-kpi-sub">${UI.formatNumber(proj24, 2)} m</span>
            </div>
            <div class="proj-kpi-item proj-kpi-cutoff">
              <span class="proj-kpi-label">A las ${cutoffTime}</span>
              <span class="proj-kpi-value">${UI.formatNumber(atCutoff.levelPct, 1)}%</span>
              <span class="proj-kpi-sub">${UI.formatNumber(atCutoff.levelM, 2)} m (en ${UI.formatNumber(atCutoff.hoursAhead, 1)}h)</span>
            </div>
            <div class="proj-kpi-item">
              <span class="proj-kpi-label">T. hasta Lleno</span>
              <span class="proj-kpi-value">${Calculator.formatTime(ttf)}</span>
            </div>
            <div class="proj-kpi-item">
              <span class="proj-kpi-label">T. hasta Vacío</span>
              <span class="proj-kpi-value">${Calculator.formatTime(tte)}</span>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function renderProjectionTable(tanks, hours) {
    const steps = Math.min(hours, 24);
    const now   = new Date();
    const thead = document.getElementById('projectionTableHead');
    const tbody = document.getElementById('projectionTableBody');
    if (!thead || !tbody) return;

    thead.innerHTML = `
      <tr>
        <th>Hora</th>
        ${tanks.map(t =>
          `<th style="color:${t.color || '#0ea5e9'}">${t.name}<br/><small>(m / %)</small></th>`
        ).join('')}
      </tr>`;

    const rows = [];
    for (let i = 0; i <= steps; i++) {
      const h       = (hours / steps) * i;
      const t       = new Date(now.getTime() + h * 3600000);
      const timeStr = t.toLocaleString('es-CO', {
        hour: '2-digit', minute: '2-digit',
        day: '2-digit', month: '2-digit'
      });

      const cells = tanks.map(tank => {
        const levelM   = Calculator.projectLevel(tank, h);
        const levelPct = Math.min(100, Math.max(0, (levelM / tank.height) * 100));
        return `<td class="${UI.getLevelClass(levelPct)}">${UI.formatNumber(levelM, 2)}m / ${UI.formatNumber(levelPct, 1)}%</td>`;
      });

      rows.push(`
        <tr ${i === 0 ? 'class="current-row"' : ''}>
          <td><strong>${timeStr}</strong>${i === 0 ? ' <span class="now-badge">AHORA</span>' : ''}</td>
          ${cells.join('')}
        </tr>`);
    }
    tbody.innerHTML = rows.join('');
  }

  // ─── REPORTES ─────────────────────────────────────────────────────────
  function bindReports() {
    document.getElementById('exportPdfStatus').addEventListener('click', () =>
      Exporter.exportStatusPDF(state.tanks));
    document.getElementById('exportExcelStatus').addEventListener('click', () =>
      Exporter.exportStatusExcel(state.tanks));
    document.getElementById('exportPdfProjection').addEventListener('click', () =>
      Exporter.exportProjectionPDF(state.tanks, parseInt(document.getElementById('reportHorizon').value)));
    document.getElementById('exportExcelProjection').addEventListener('click', () =>
      Exporter.exportProjectionExcel(state.tanks, parseInt(document.getElementById('reportHorizon').value)));
    document.getElementById('exportPdfConfig').addEventListener('click', () =>
      Exporter.exportConfigPDF(state.tanks));
    document.getElementById('exportExcelConfig').addEventListener('click', () =>
      Exporter.exportConfigExcel(state.tanks));

    // NUEVOS: Import/Export JSON
    document.getElementById('exportConfigJsonBtn').addEventListener('click', () => {
      Exporter.exportConfigurationJSON(state.tanks);
    });

    document.getElementById('importConfigBtn').addEventListener('click', handleImportClick);
    document.getElementById('importConfigFile').addEventListener('change', handleFileSelect);
  }

  function handleImportClick() {
    const fileInput = document.getElementById('importConfigFile');
    if (!fileInput.files.length) {
      UI.showToast('Por favor selecciona un archivo', 'warning');
      return;
    }

    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = function(e) {
      try {
        const fileContent = e.target.result;
        const result = Exporter.importConfigurationJSON(fileContent);

        if (!result.success) {
          throw new Error(result.error);
        }

        const importedData = result.data;
        const tanksCount = importedData.tanks.length;

        // Mostrar confirmación
        const confirmed = confirm(
          `✓ Se importarán ${tanksCount} tanque(s).\n\n` +
          `¿Desea reemplazar la configuración actual?`
        );

        if (!confirmed) return;

        // Importar datos
        const currentData = Storage.load();
        currentData.tanks = importedData.tanks;
        if (importedData.settings) {
          currentData.settings = { ...currentData.settings, ...importedData.settings };
        }

        Storage.save(currentData);
        state.tanks = currentData.tanks;
        state.settings = currentData.settings;

        // Limpiar input
        fileInput.value = '';

        // Mostrar estado
        const statusEl = document.getElementById('importStatus');
        statusEl.className = 'import-status success';
        statusEl.innerHTML = `
          <strong>✓ Importación exitosa</strong><br>
          ${tanksCount} tanque(s) importado(s) correctamente
        `;
        setTimeout(() => statusEl.className = 'import-status', 3000);

        // Refrescar UI
        renderCurrentView();
        UI.showToast(`${tanksCount} tanque(s) importado(s) correctamente`, 'success');

      } catch (error) {
        const statusEl = document.getElementById('importStatus');
        statusEl.className = 'import-status error';
        statusEl.innerHTML = `
          <strong>✗ Error en la importación</strong><br>
          ${error.message}
        `;

        UI.showToast(`Error: ${error.message}`, 'error', 5000);
        console.error('Import error:', error);
      }
    };

    reader.onerror = function() {
      UI.showToast('Error al leer el archivo', 'error');
    };

    reader.readAsText(file);
  }

  function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file) {
      const fileName = file.name;
      const fileSize = (file.size / 1024).toFixed(2);
      console.log(`Archivo seleccionado: ${fileName} (${fileSize} KB)`);
    }
  }

  function renderReports() {
    const preview = document.getElementById('reportPreview');
    if (!preview) return;

    if (state.tanks.length === 0) {
      preview.innerHTML = '<p class="empty-text">No hay datos para reportar</p>';
      return;
    }

    preview.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Tanque</th>
            <th>Nivel</th>
            <th>Volumen</th>
            <th>Entrada</th>
            <th>Salida</th>
            <th>Tendencia</th>
            <th>T. Crítico</th>
          </tr>
        </thead>
        <tbody>
          ${state.tanks.map(tank => {
            const pct       = Calculator.levelPercent(tank);
            const vol       = Calculator.currentVolume(tank);
            const trendType = Calculator.trend(tank);
            const ttf       = Calculator.timeToFull(tank);
            const tte       = Calculator.timeToEmpty(tank);
            const critTime  = trendType === 'filling'
              ? Calculator.formatTime(ttf)
              : trendType === 'draining'
              ? Calculator.formatTime(tte)
              : '—';
            return `
              <tr>
                <td>
                  <span class="tank-color-dot" style="background:${tank.color || '#0ea5e9'}"></span>
                  ${tank.name}
                </td>
                <td class="${UI.getLevelClass(pct)}">${UI.formatNumber(pct, 1)}% (${UI.formatNumber(tank.currentLevelM, 2)}m)</td>
                <td>${UI.formatNumber(vol, 1)} m³</td>
                <td class="text-green">↑ ${UI.formatNumber(tank.currentInflow || 0, 2)}</td>
                <td class="text-red">↓ ${UI.formatNumber(tank.outflow || 0, 2)}</td>
                <td>${UI.getTrendIcon(trendType)}</td>
                <td>${critTime}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }

  // ─── RELOJ Y AUTO-REFRESH ─────────────────────────────────────────────
  function startClock() {
    const tick = () => {
      const el = document.getElementById('systemTime');
      if (el) el.textContent = new Date().toLocaleTimeString('es-CO');
    };
    tick();
    setInterval(tick, 1000);
  }

  function startAutoRefresh() {
    if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = setInterval(() => {
      updateAlertBadge();
      if (state.currentView === 'dashboard') renderDashboard();
    }, 30000);
  }

  function bindRefresh() {
    document.getElementById('refreshBtn').addEventListener('click', () => {
      loadData();
      renderCurrentView();
      UI.showToast('Datos actualizados', 'success');
    });
  }

  // ─── API PÚBLICA ──────────────────────────────────────────────────────
  return {
    init,
    openAddTankModal,
    openEditTankModal,
    openTankDetail,
    advanceTime,
    deleteTank,
    navigateTo
  };
})();

// ═══════════════════════════════════════════════════════════════════════════
// ARRANQUE
// ═══════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => App.init());
