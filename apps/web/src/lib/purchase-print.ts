/** Dữ liệu bản in hợp đồng mua / packing list (PurchaseSheet) từ đơn mua hoặc lô hàng nhập. */
import { containerPlan, containerPlanLabel } from '$shared/packing';
import type { SheetHeader, SheetLine } from '$lib/components/print/PurchaseSheet.svelte';
import type { ShipmentDetail } from '$lib/components/record/ImportShipmentRecord.svelte';
import type { PurchaseOrderDetail } from '$lib/purchase';

type OrderWithSupplier = PurchaseOrderDetail & { supplier?: { name: string; address?: string; phone?: string } | null };

function seller(order: OrderWithSupplier | null): SheetHeader['seller'] {
  return { name: order?.supplier?.name ?? order?.supplierName ?? '', address: order?.supplier?.address, phone: order?.supplier?.phone };
}

export function orderSheet(order: OrderWithSupplier, title: 'contract' | 'packing'): { header: SheetHeader; lines: SheetLine[] } {
  const lines: SheetLine[] = order.lines.map((line) => ({
    itemNo: line.print?.supplierItemCode ?? line.sku,
    sku: line.sku,
    nameEn: line.print?.nameEn ?? line.productName,
    nameZh: line.print?.nameZh ?? '',
    spec: [line.print?.specEn, line.print?.specZh].filter(Boolean).join(' / '),
    hsCode: line.print?.hsCode ?? '',
    unit: line.unit,
    quantity: Number(line.quantity),
    unitPrice: line.unitCost,
    amount: line.lineTotal,
    packSize: line.print?.packSize,
    cartons: line.packing?.cartons ?? 0,
    netKg: line.packing?.netKg ?? 0,
    grossKg: line.packing?.grossKg ?? 0,
    cbm: line.packing?.cbm ?? 0,
  }));
  return {
    header: {
      title,
      number: order.supplierContractNo || order.code,
      date: order.contractDate ?? order.createdAt,
      seller: seller(order),
      currency: order.currency ?? 'VND',
      incoterm: order.incoterm,
      portOfLoading: order.portOfLoading,
      portOfDischarge: order.portOfDischarge,
      shippingMethod: order.shippingMethod,
      etd: order.etd,
      eta: order.eta,
      paymentTerms: order.paymentTerms,
      depositPercent: order.depositPercent,
      partialShipment: order.partialShipment,
      shippingMark: order.shippingMark,
      reference: order.code,
      total: order.total,
      container: order.packing?.container ?? '',
    },
    lines,
  };
}

export function shipmentSheet(shipment: ShipmentDetail, order: OrderWithSupplier | null): { header: SheetHeader; lines: SheetLine[] } {
  const lines: SheetLine[] = shipment.lines.map((line) => {
    const print = (line as unknown as { print?: { nameEn?: string; nameZh?: string; specEn?: string; specZh?: string; hsCode?: string; supplierItemCode?: string; packSize?: number } }).print ?? {};
    return {
      itemNo: print.supplierItemCode ?? line.sku,
      sku: line.sku,
      nameEn: print.nameEn ?? line.productName,
      nameZh: print.nameZh ?? '',
      spec: [print.specEn, print.specZh].filter(Boolean).join(' / '),
      hsCode: print.hsCode ?? '',
      unit: line.baseUnit,
      quantity: Number(line.quantity),
      packSize: print.packSize,
      cartons: line.cartons,
      netKg: (line as unknown as { netKg?: number }).netKg ?? 0,
      grossKg: line.grossKg,
      cbm: line.cbm,
    };
  });
  const cbm = lines.reduce((sum, line) => sum + line.cbm, 0);
  const kg = lines.reduce((sum, line) => sum + line.grossKg, 0);
  return {
    header: {
      title: 'packing',
      number: `${shipment.code}${order?.supplierContractNo ? ` / ${order.supplierContractNo}` : ''}`,
      date: shipment.etd ?? shipment.createdAt,
      seller: seller(order),
      currency: order?.currency ?? 'VND',
      portOfLoading: order?.portOfLoading,
      portOfDischarge: order?.portOfDischarge,
      shippingMethod: order?.shippingMethod,
      etd: shipment.etd,
      eta: shipment.eta,
      shippingMark: order?.shippingMark,
      containerNo: shipment.containerNo,
      containerType: shipment.containerType,
      billOfLading: shipment.billOfLading,
      vessel: shipment.vessel,
      container: shipment.containerType ?? containerPlanLabel(containerPlan(cbm, kg)),
    },
    lines,
  };
}
