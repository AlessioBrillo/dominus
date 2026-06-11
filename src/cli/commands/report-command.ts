import { type Command } from 'commander';
import type { PortfolioReportService } from '../../portfolio/portfolio-report-service.js';

export function registerReportCommand(
  program: Command,
  deps: { reportService: PortfolioReportService },
): void {
  const { reportService } = deps;

  const reportCmd = program.command('report').description('Generate portfolio reports and metrics');

  reportCmd
    .command('summary')
    .description('Show aggregate portfolio summary')
    .action(async () => {
      try {
        const report = await reportService.generate();
        console.log('=== Portfolio Summary ===');
        console.log(`Generated:        ${report.generatedAt}`);
        console.log(`Total domains:    ${report.totalDomains}`);
        console.log(`Total acquisition: €${report.totalAcquisitionCost.toFixed(2)}`);
        console.log(`Annual renewal:   €${report.totalAnnualRenewalCost.toFixed(2)}`);
        console.log(`Monthly burn:     €${report.monthlyBurnRate.toFixed(2)}`);
        console.log(
          `Avg score:        ${report.averageScore}/100 (${report.domainsWithScore} scored)`,
        );
        console.log(`Total list price: €${report.totalSuggestedListPrice.toFixed(2)}`);
        console.log(`Realised revenue: €${report.totalRealisedRevenue.toFixed(2)}`);
        console.log(`Renewal cost paid: €${report.totalRenewalCostPaid.toFixed(2)}`);
        console.log(`Net profit:       €${report.netProfit.toFixed(2)}`);
        console.log(`ROI:              ${report.roiPct}%`);
        console.log('');
        console.log('--- By Verdict ---');
        for (const v of report.breakdownByVerdict) {
          console.log(
            `  ${v.verdict}: ${v.count} domains (acq: €${v.totalAcquisitionCost.toFixed(2)})`,
          );
        }
        console.log('');
        console.log('--- By TLD (top 5) ---');
        for (const t of report.breakdownByTld.slice(0, 5)) {
          console.log(
            `  ${t.tld}: ${t.count} domains (renewal: €${t.totalAnnualRenewalCost.toFixed(2)})`,
          );
        }
        if (report.domainsAtRisk.length > 0) {
          console.log('');
          console.log(`--- At-Risk Domains (${report.domainsAtRisk.length}) ---`);
          for (const r of report.domainsAtRisk.slice(0, 10)) {
            console.log(
              `  ${r.domain}: renewal in ${r.daysUntilRenewal}d, score=${r.currentScore ?? 'N/A'}`,
            );
          }
          if (report.domainsAtRisk.length > 10) {
            console.log(`  ... and ${report.domainsAtRisk.length - 10} more`);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Report failed: ${message}`);
        process.exit(1);
      }
    });

  reportCmd
    .command('tld')
    .description('Show breakdown by TLD')
    .action(async () => {
      try {
        const report = await reportService.generate();
        console.log('=== TLD Breakdown ===');
        for (const t of report.breakdownByTld) {
          const pct =
            report.totalAcquisitionCost > 0
              ? ((t.totalAcquisitionCost / report.totalAcquisitionCost) * 100).toFixed(1)
              : '0.0';
          console.log(
            `${t.tld}: ${t.count} domains, €${t.totalAcquisitionCost.toFixed(0)} acq (${pct}%), ` +
              `€${t.totalAnnualRenewalCost.toFixed(0)}/yr renewal`,
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Report failed: ${message}`);
        process.exit(1);
      }
    });

  reportCmd
    .command('risk')
    .description('Show domains at risk (renewal imminent or low score)')
    .action(async () => {
      try {
        const report = await reportService.generate();
        if (report.domainsAtRisk.length === 0) {
          console.log('No domains at risk.');
          return;
        }
        console.log(`=== ${report.domainsAtRisk.length} Domain(s) at Risk ===`);
        for (const r of report.domainsAtRisk) {
          const reasons: string[] = [];
          if (r.daysUntilRenewal <= 7) reasons.push('CRITICAL renewal');
          else if (r.daysUntilRenewal <= 30) reasons.push('renewal imminent');
          if (r.currentScore !== undefined && r.currentScore < 25) reasons.push('low score');
          console.log(
            `  ${r.domain}: ${r.daysUntilRenewal}d to renewal, ` +
              `score=${r.currentScore ?? 'N/A'}, ` +
              `list=€${r.suggestedListPrice?.toFixed(0) ?? 'N/A'} ` +
              `[${reasons.join(', ')}]`,
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Report failed: ${message}`);
        process.exit(1);
      }
    });

  reportCmd
    .command('roi')
    .description('Show ROI breakdown for all domains')
    .action(async () => {
      try {
        const report = await reportService.allRoi();
        console.log('=== Portfolio ROI ===');
        console.log(`Total domains:    ${report.totalDomains}`);
        console.log(`Sold:             ${report.soldDomains}`);
        console.log(`Holding:          ${report.holdingDomains}`);
        console.log(`Dropped/Expired:  ${report.droppedDomains}`);
        console.log(`Total cost:       €${report.totalCost.toFixed(2)}`);
        console.log(`Total revenue:    €${report.totalRevenue.toFixed(2)}`);
        console.log(`Net profit:       €${report.netProfit.toFixed(2)}`);
        console.log(`ROI:              ${report.roiPct}%`);
        if (report.domainDetails.length > 0) {
          console.log('');
          console.log('--- Per Domain ---');
          for (const d of report.domainDetails) {
            const statusIcon =
              d.status === 'sold' ? 'SOLD' : d.status === 'holding' ? 'HOLD' : 'DROP';
            const roiStr = d.status === 'sold' ? `${d.roiPct}%` : 'N/A';
            const saleStr = d.salePriceEur !== undefined ? `€${d.salePriceEur.toFixed(0)}` : '—';
            console.log(
              `  [${statusIcon}] ${d.domain}: cost=€${d.totalCost.toFixed(0)}, ` +
                `sale=${saleStr}, roi=${roiStr}, ${d.daysHeld}d held`,
            );
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Report failed: ${message}`);
        process.exit(1);
      }
    });

  reportCmd
    .command('csv')
    .description('Export portfolio data as CSV')
    .action(async () => {
      try {
        const report = await reportService.allRoi();
        console.log(
          'domain,status,acquisition_cost,total_renewal_cost,total_cost,sale_price,net_profit,roi_pct,days_held',
        );
        for (const d of report.domainDetails) {
          console.log(
            `${d.domain},${d.status},${d.acquisitionCost.toFixed(2)},` +
              `${d.totalRenewalCostPaid.toFixed(2)},${d.totalCost.toFixed(2)},` +
              `${d.salePriceEur?.toFixed(2) ?? ''},${d.netProfit.toFixed(2)},` +
              `${d.roiPct},${d.daysHeld}`,
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Report failed: ${message}`);
        process.exit(1);
      }
    });
}
