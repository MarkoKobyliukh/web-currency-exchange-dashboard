/* =====================================================================
   UAH Exchange Rates - NBU API, XMLHttpRequest (AJAX), Chart.js
   Structure: MVC
     Model      - talks to the NBU API (XHR wrapped in Promises)
     View       - everything that touches the DOM and Chart.js
     Controller - events, routing (#/ and #/USD), glue between the two
   ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------ Config ------------------------------ */
  var NBU_URL = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange';
  var MAX_RANGE_DAYS = 366;
  var DEFAULT_RANGE_DAYS = 30;

  var CURRENCIES = [
    { code: 'USD', name: 'US dollar',         flag: 'us' },
    { code: 'EUR', name: 'Euro',              flag: 'eu' },
    { code: 'GBP', name: 'Pound sterling',    flag: 'gb' },
    { code: 'PLN', name: 'Polish zloty',      flag: 'pl' },
    { code: 'CHF', name: 'Swiss franc',       flag: 'ch' },
    { code: 'JPY', name: 'Japanese yen',      flag: 'jp' },
    { code: 'CZK', name: 'Czech koruna',      flag: 'cz' },
    { code: 'CAD', name: 'Canadian dollar',   flag: 'ca' },
    { code: 'CNY', name: 'Chinese yuan',      flag: 'cn' },
    { code: 'TRY', name: 'Turkish lira',      flag: 'tr' }
  ];

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];

  /* ------------------------------ Helpers ----------------------------- */
  function pad(n) { return String(n).padStart(2, '0'); }

  function toApiDate(d) {                      // 20261015
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  }

  function toInputDate(d) {                    // 2026-10-15
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function fromInputDate(str) {                // "2026-10-15" -> Date (local)
    var p = str.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function fromNbuDate(str) {                  // "15.10.2026" -> Date (local)
    var p = str.split('.');
    return new Date(+p[2], +p[1] - 1, +p[0]);
  }

  function formatShort(d) {                    // 15.10.2026
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
  }

  function formatLong(d) {                     // 15 October 2026
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  function addDays(d, n) {
    var r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    r.setDate(r.getDate() + n);
    return r;
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function formatRate(v) {
    return v.toFixed(v < 1 ? 5 : 4);
  }

  function findCurrency(code) {
    for (var i = 0; i < CURRENCIES.length; i++) {
      if (CURRENCIES[i].code === code) return CURRENCIES[i];
    }
    return null;
  }

  /* ===================================================================
     MODEL
     =================================================================== */
  var Model = {

    /** Plain XMLHttpRequest wrapped in a Promise. Resolves with parsed JSON. */
    request: function (url) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.timeout = 15000;

        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch (e) {
              reject(new Error('NBU returned invalid data.'));
            }
          } else {
            reject(new Error('NBU request failed (HTTP ' + xhr.status + ').'));
          }
        };
        xhr.onerror = function () { reject(new Error('Network error while contacting NBU.')); };
        xhr.ontimeout = function () { reject(new Error('NBU request timed out.')); };

        xhr.send();
      });
    },

    /**
     * Rates for ONE day. Without `code` the NBU returns all currencies.
     * Resolves with [{ code, date: Date, value }] (UAH per 1 unit). Empty array = no data that day.
     */
    getDay: function (date, code) {
      var url = NBU_URL + '?' + (code ? 'valcode=' + code + '&' : '') +
                'date=' + toApiDate(date) + '&json';

      return Model.request(url).then(function (raw) {
        var out = [];
        if (!Array.isArray(raw)) return out;
        raw.forEach(function (item) {
          var value = Number(item.rate);
          if (!item.exchangedate || isNaN(value)) return;
          out.push({ code: item.cc, date: fromNbuDate(item.exchangedate), value: value });
        });
        return out;
      });
    },

    /**
     * Rates for one currency in a date range (one request per day, max 8 at a time).
     * Returns [{ date: Date, value: Number }] sorted from oldest to newest.
     */
    getRange: function (code, startDate, endDate) {
      var dates = [];
      for (var d = startOfDay(startDate); d <= endDate; d = addDays(d, 1)) dates.push(d);

      return new Promise(function (resolve, reject) {
        if (!dates.length) { resolve([]); return; }

        var LIMIT = 8;
        var next = 0, running = 0, done = 0, failed = 0, firstError = null;
        var byDay = {};

        function finish() {
          if (failed === dates.length) { reject(firstError); return; }
          var points = Object.keys(byDay).map(function (k) { return byDay[k]; });
          points.sort(function (a, b) { return a.date - b.date; });
          resolve(points);
        }

        function launch() {
          while (running < LIMIT && next < dates.length) {
            (function (day) {
              running++;
              Model.getDay(day, code).then(function (res) {
                res.forEach(function (p) {
                  if (p.code === code) byDay[toApiDate(p.date)] = { date: p.date, value: p.value };
                });
              }, function (err) {
                failed++;
                firstError = firstError || err;
              }).then(function () {
                running--; done++;
                if (done === dates.length) finish(); else launch();
              });
            })(dates[next++]);
          }
        }

        launch();
      });
    },

    /**
     * Main page data: asks the NBU for the last 5 days (one XHR per day, all
     * currencies at once) and returns [{ code, date, value, prev }] for the given codes.
     */
    getHomeRates: function (codes) {
      var today = startOfDay(new Date());
      var days = [];
      for (var i = 0; i < 5; i++) days.push(addDays(today, -i));

      return Promise.all(days.map(function (day) {
        return Model.getDay(day).then(
          function (res) { return { ok: true, res: res }; },
          function (err) { return { ok: false, err: err }; }
        );
      })).then(function (results) {
        var okResults = results.filter(function (r) { return r.ok; });
        if (!okResults.length) throw results[0].err;

        var byCode = {};
        okResults.forEach(function (r) {
          r.res.forEach(function (p) {
            if (codes.indexOf(p.code) === -1) return;
            (byCode[p.code] = byCode[p.code] || []).push(p);
          });
        });

        return Object.keys(byCode).map(function (code) {
          var pts = byCode[code].sort(function (a, b) { return a.date - b.date; });
          var last = pts[pts.length - 1];
          var prev = pts.length > 1 ? pts[pts.length - 2] : null;
          return { code: code, date: last.date, value: last.value, prev: prev ? prev.value : null };
        });
      });
    }
  };

  /* ===================================================================
     VIEW
     =================================================================== */
  var View = {
    chart: null,

    el: function (id) { return document.getElementById(id); },

    showHome: function () {
      View.el('view-home').classList.remove('d-none');
      View.el('view-detail').classList.add('d-none');
      window.scrollTo(0, 0);
    },

    showDetail: function () {
      View.el('view-home').classList.add('d-none');
      View.el('view-detail').classList.remove('d-none');
      window.scrollTo(0, 0);
    },

    /* ----- home ----- */
    setHomeLoading: function (on) {
      View.el('home-loading').classList.toggle('d-none', !on);
      View.el('rates-table').classList.toggle('d-none', on);
    },

    setHomeError: function (msg) {
      var box = View.el('home-error');
      box.textContent = msg || '';
      box.classList.toggle('d-none', !msg);
    },

    renderHome: function (rows, date) {
      View.el('home-date').textContent = date ? formatLong(date) : '';

      var tbody = View.el('rates-body');
      tbody.innerHTML = '';

      rows.forEach(function (row) {
        var cur = findCurrency(row.code);

        var trend = '<span class="trend-flat">&ndash;</span>';
        if (row.prev !== null) {
          if (row.value > row.prev) trend = '<span class="trend-up" title="Up vs previous rate">&uarr;</span>';
          else if (row.value < row.prev) trend = '<span class="trend-down" title="Down vs previous rate">&darr;</span>';
        }

        var tr = document.createElement('tr');
        tr.setAttribute('data-code', row.code);
        tr.innerHTML =
          '<td style="width:150px">' +
            '<img class="flag" src="https://flagcdn.com/w40/' + cur.flag + '.png" alt="' + cur.code + '">' +
            '<span class="code">' + cur.code + '</span>' +
          '</td>' +
          '<td>' + cur.name + '</td>' +
          '<td class="text-center" style="width:60px">' + trend + '</td>' +
          '<td class="spot">' + formatRate(row.value) + '</td>' +
          '<td class="text-center" style="width:90px">' +
            '<svg class="chart-icon" viewBox="0 0 24 24" aria-label="Chart">' +
              '<path d="M3 3v18h18"/><path d="M6 15l4-5 3 3 5-7"/>' +
            '</svg>' +
          '</td>';
        tbody.appendChild(tr);
      });
    },

    /* ----- detail ----- */
    fillCurrencySelect: function () {
      var select = View.el('currency-select');
      select.innerHTML = '';
      CURRENCIES.forEach(function (c) {
        var opt = document.createElement('option');
        opt.value = c.code;
        opt.textContent = c.code + ' - ' + c.name;
        select.appendChild(opt);
      });
    },

    setDetailLoading: function (on) {
      View.el('detail-loading').classList.toggle('d-none', !on);
      View.el('chart-btn').disabled = on;
    },

    setDetailError: function (msg) {
      var box = View.el('detail-error');
      box.textContent = msg || '';
      box.classList.toggle('d-none', !msg);
    },

    setForm: function (code, start, end) {
      View.el('currency-select').value = code;
      View.el('start-date').value = toInputDate(start);
      View.el('end-date').value = toInputDate(end);
    },

    getForm: function () {
      return {
        code: View.el('currency-select').value,
        startStr: View.el('start-date').value,
        endStr: View.el('end-date').value
      };
    },

    renderDetail: function (code, points, start, end) {
      var cur = findCurrency(code);
      View.el('detail-title').textContent = cur.name + ' (' + cur.code + ')';

      var summaryDate = View.el('summary-date');
      var summaryRate = View.el('summary-rate');
      var period = View.el('summary-period');

      period.innerHTML = 'Period: <strong>' + formatLong(start) + '</strong> to <strong>' +
                         formatLong(end) + '</strong>';

      if (!points.length) {
        summaryDate.textContent = '';
        summaryRate.textContent = 'No data for this period';
        View.fillStats(null);
        View.drawChart(code, []);
        return;
      }

      var last = points[points.length - 1];
      var prev = points.length > 1 ? points[points.length - 2] : null;

      summaryDate.textContent = formatLong(last.date);

      var html = '1 ' + cur.code + ' = UAH ' + formatRate(last.value);
      if (prev) {
        var diff = last.value - prev.value;
        var pct = prev.value ? (diff / prev.value) * 100 : 0;
        var sign = diff >= 0 ? '+' : '';
        var cls = diff >= 0 ? 'delta-up' : 'delta-down';
        html += '<span class="' + cls + '">' + sign + diff.toFixed(4) +
                ' (' + sign + pct.toFixed(2) + '%)</span>';
      }
      summaryRate.innerHTML = html;

      View.fillStats(points);
      View.drawChart(code, points);
    },

    fillStats: function (points) {
      var minEl = View.el('stat-min'), maxEl = View.el('stat-max'), avgEl = View.el('stat-avg');
      var minLbl = View.el('stat-min-label'), maxLbl = View.el('stat-max-label');

      if (!points || !points.length) {
        minEl.textContent = maxEl.textContent = avgEl.textContent = '-';
        minLbl.textContent = 'Min';
        maxLbl.textContent = 'Max';
        return;
      }

      var min = points[0], max = points[0], sum = 0;
      points.forEach(function (p) {
        if (p.value < min.value) min = p;
        if (p.value > max.value) max = p;
        sum += p.value;
      });

      minLbl.textContent = 'Min (' + formatLong(min.date) + ')';
      maxLbl.textContent = 'Max (' + formatLong(max.date) + ')';
      minEl.textContent = formatRate(min.value);
      maxEl.textContent = formatRate(max.value);
      avgEl.textContent = formatRate(sum / points.length);
    },

    drawChart: function (code, points) {
      if (View.chart) {
        View.chart.destroy();
        View.chart = null;
      }

      var ctx = View.el('rate-chart').getContext('2d');
      var many = points.length > 60;

      View.chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: points.map(function (p) { return formatShort(p.date); }),
          datasets: [{
            label: 'UAH per 1 ' + code,
            data: points.map(function (p) { return p.value; }),
            borderColor: '#3f75c0',
            backgroundColor: 'rgba(63, 117, 192, 0.12)',
            borderWidth: 2,
            pointRadius: many ? 0 : 3,
            pointHoverRadius: 5,
            tension: 0.15,
            fill: true
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            title: { display: true, text: code + ' rates in UAH', font: { size: 16 } },
            subtitle: { display: true, text: 'Source: National Bank of Ukraine (bank.gov.ua)' },
            legend: { display: true },
            tooltip: {
              callbacks: {
                label: function (c) { return ' UAH ' + formatRate(c.parsed.y); }
              }
            }
          },
          scales: {
            x: { ticks: { maxTicksLimit: 12, maxRotation: 0 }, grid: { display: false } },
            y: { title: { display: true, text: 'UAH' } }
          }
        }
      });
    }
  };

  /* ===================================================================
     CONTROLLER
     =================================================================== */
  var Controller = {
    state: { code: 'USD', start: null, end: null },

    init: function () {
      View.fillCurrencySelect();

      // default period: last 30 days
      var today = startOfDay(new Date());
      Controller.state.end = today;
      Controller.state.start = addDays(today, -DEFAULT_RANGE_DAYS);

      // click on a row (anywhere) -> open the detail page
      View.el('rates-body').addEventListener('click', function (e) {
        var tr = e.target.closest('tr');
        if (tr) location.hash = '#/' + tr.getAttribute('data-code');
      });

      // Chart button / Enter key
      View.el('filter-form').addEventListener('submit', function (e) {
        e.preventDefault();
        Controller.applyForm();
      });

      // changing currency in the dropdown
      View.el('currency-select').addEventListener('change', function () {
        var code = View.el('currency-select').value;
        var form = View.getForm();
        if (form.startStr && form.endStr) {
          Controller.state.start = fromInputDate(form.startStr);
          Controller.state.end = fromInputDate(form.endStr);
        }
        location.hash = '#/' + code;
      });

      // zoom presets
      Array.prototype.forEach.call(document.querySelectorAll('.preset-btn'), function (btn) {
        btn.addEventListener('click', function () {
          var days = Number(btn.getAttribute('data-days'));
          var end = startOfDay(new Date());
          Controller.state.end = end;
          Controller.state.start = addDays(end, -days);
          View.setForm(Controller.state.code, Controller.state.start, Controller.state.end);
          Controller.loadDetail();
        });
      });

      window.addEventListener('hashchange', Controller.route);
      Controller.route();
    },

    route: function () {
      var match = location.hash.match(/^#\/([A-Za-z]{3})$/);
      var cur = match ? findCurrency(match[1].toUpperCase()) : null;

      if (cur) {
        Controller.state.code = cur.code;
        View.showDetail();
        View.setForm(cur.code, Controller.state.start, Controller.state.end);
        Controller.loadDetail();
      } else {
        View.showHome();
        Controller.loadHome();
      }
    },

    /* ----- home page ----- */
    loadHome: function () {
      View.setHomeError('');
      View.setHomeLoading(true);

      var codes = CURRENCIES.map(function (c) { return c.code; });

      Model.getHomeRates(codes).then(function (rows) {
        View.setHomeLoading(false);

        if (!rows.length) {
          View.setHomeError('The NBU returned no rates.');
          return;
        }

        var latest = rows.reduce(function (max, r) { return r.date > max ? r.date : max; }, rows[0].date);
        rows.sort(function (a, b) { return codes.indexOf(a.code) - codes.indexOf(b.code); });

        var missing = codes.filter(function (c) {
          return !rows.some(function (r) { return r.code === c; });
        });
        if (missing.length) {
          View.setHomeError('Some currencies are missing: ' + missing.join(', ') + '.');
        }
        View.renderHome(rows, latest);
      }).catch(function (err) {
        View.setHomeLoading(false);
        View.setHomeError('Could not load rates from the NBU: ' + err.message);
      });
    },

    /* ----- detail page ----- */
    applyForm: function () {
      var form = View.getForm();

      if (!form.startStr || !form.endStr) {
        View.setDetailError('Please choose both a start and an end date.');
        return;
      }

      var start = fromInputDate(form.startStr);
      var end = fromInputDate(form.endStr);

      if (start > end) {
        View.setDetailError('The start date cannot be after the end date.');
        return;
      }
      var days = Math.round((end - start) / 86400000);
      if (days > MAX_RANGE_DAYS) {
        View.setDetailError('The period is too long. Please choose at most one year.');
        return;
      }

      Controller.state.start = start;
      Controller.state.end = end;

      if (form.code !== Controller.state.code) {
        location.hash = '#/' + form.code;     // route() will load the chart
      } else {
        Controller.loadDetail();
      }
    },

    loadDetail: function () {
      var s = Controller.state;
      var code = s.code, start = s.start, end = s.end;

      View.setDetailError('');
      View.setDetailLoading(true);

      Model.getRange(code, start, end).then(function (points) {
        // ignore the answer if the user already switched to another currency
        if (code !== Controller.state.code) return;
        View.setDetailLoading(false);
        View.renderDetail(code, points, start, end);
        if (!points.length) {
          View.setDetailError('The NBU has no rates for this period.');
        }
      }).catch(function (err) {
        View.setDetailLoading(false);
        View.setDetailError(err.message || 'Could not load data.');
      });
    }
  };

  document.addEventListener('DOMContentLoaded', Controller.init);
})();