const service = require('../services/driverSettlement.service');

exports.getPendingDriverSettlements = async (_req, res) => {
  try {
    res.json(await service.getPendingSettlements());
  } catch {
    res.status(500).json({ message: 'Failed to fetch pending settlements' });
  }
};

exports.payDriverSettlement = async (req, res) => {
  const { driverId, utr } = req.body;
  if (!driverId || !utr) {
    return res.status(400).json({ message: 'driverId and utr required' });
  }

  try {
    const r = await service.markSettlementPaid(driverId, utr);
    res.json({
      success: true,
      driverId: r.driverId,
      paidAmountPaise: r.total,
      paidAmountRupees: (r.total / 100).toFixed(2),
      utr: r.utr,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

exports.getSettlementHistory = async (req, res) => {
  const { fromDate, toDate } = req.query;
  try {
    res.json(await service.getSettlementHistory(fromDate, toDate));
  } catch {
    res.status(500).json({ message: 'Failed to fetch settlement history' });
  }
};

exports.getWeeklySummary = async (_req, res) => {
  try {
    res.json(await service.getWeeklySettlementSummary());
  } catch {
    res.status(500).json({ message: 'Failed to fetch weekly summary' });
  }
};

/**
 * GET /export → CSV download
 */
exports.exportSettlementHistoryCSV = async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;
    const rows = await service.getSettlementHistoryForExport(fromDate, toDate);

    let csv = 'Driver,Amount (₹),UTR,Settled At\n';

    rows.forEach(r => {
      csv += `"${r.driver_name}",${r.amount_rupees},"${r.utr}","${r.settled_at}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="settlement_history.csv"'
    );

    res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'CSV export failed' });
  }
};