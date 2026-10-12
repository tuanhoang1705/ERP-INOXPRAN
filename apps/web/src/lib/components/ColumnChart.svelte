<script lang="ts">
  /**
   * Biểu đồ cột một chuỗi: cột navy, cột nhấn màu cam (kỳ đang thực hiện), nhãn giá trị trên đầu cột,
   * trục y tối giản và tooltip khi rê chuột/focus. Có bảng dữ liệu ẩn cho trình đọc màn hình.
   */
  interface Column { label: string; value: number; highlight?: boolean; tooltip?: string }
  let {
    data,
    format = (value: number) => String(value),
    axisFormat = (value: number) => String(value),
    caption,
    height = 210,
  }: {
    data: Column[];
    format?: (value: number) => string;
    axisFormat?: (value: number) => string;
    caption: string;
    height?: number;
  } = $props();

  let hovered = $state<number | null>(null);

  function niceMax(value: number): number {
    if (value <= 0) return 1;
    const exponent = Math.pow(10, Math.floor(Math.log10(value)));
    const fraction = value / exponent;
    const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
    return step * exponent;
  }
  const max = $derived(niceMax(Math.max(...data.map((item) => item.value), 0) * 1.12));
  const ticks = $derived([0, 1, 2, 3, 4, 5].map((index) => (max / 5) * index));
</script>

<figure class="chart" style={`--h:${height}px`}>
  <div class="plot">
    <div class="axis" aria-hidden="true">
      {#each [...ticks].reverse() as tick}<span>{axisFormat(tick)}</span>{/each}
    </div>
    <div class="grid" aria-hidden="true">
      {#each ticks as _}<i></i>{/each}
    </div>
    <div class="columns">
      {#each data as item, index}
        <button
          type="button"
          class="column"
          class:highlight={item.highlight}
          class:dim={hovered !== null && hovered !== index}
          onmouseenter={() => (hovered = index)}
          onmouseleave={() => (hovered = null)}
          onfocus={() => (hovered = index)}
          onblur={() => (hovered = null)}
          aria-label={`${item.label}: ${item.tooltip ?? format(item.value)}`}
        >
          <span class="bar-area">
            <span class="value" class:strong={item.highlight}>{format(item.value)}</span>
            <span class="bar" style={`height:${max ? (item.value / max) * 100 : 0}%`}></span>
          </span>
          <span class="label">{item.label}</span>
          {#if hovered === index}<span class="tip" role="status">{item.label}<b>{item.tooltip ?? format(item.value)}</b></span>{/if}
        </button>
      {/each}
    </div>
  </div>
  <table class="sr-only">
    <caption>{caption}</caption>
    <tbody>{#each data as item}<tr><th scope="row">{item.label}</th><td>{item.tooltip ?? format(item.value)}</td></tr>{/each}</tbody>
  </table>
</figure>

<style>
  .chart { margin: 0; }
  .plot { position: relative; display: grid; grid-template-columns: 34px 1fr; height: calc(var(--h) + 26px); }
  .axis { display: flex; flex-direction: column; justify-content: space-between; height: var(--h); padding-right: 10px; color: var(--subtle); font-size: 11.5px; text-align: right; transform: translateY(-7px); }
  .axis span { line-height: 14px; }
  .grid { position: absolute; left: 34px; right: 0; top: 0; display: flex; flex-direction: column; justify-content: space-between; height: var(--h); pointer-events: none; }
  .grid i { display: block; height: 1px; background: var(--line-soft); }
  .grid i:last-child { background: var(--line); }
  .columns { position: relative; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: clamp(10px, 3vw, 40px); padding: 0 14px; }
  .column { position: relative; display: flex; flex-direction: column; align-items: center; min-width: 0; padding: 0; cursor: default; }
  .bar-area { position: relative; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; width: 100%; height: var(--h); }
  .bar { display: block; width: min(56px, 78%); min-height: 2px; border-radius: 4px 4px 0 0; background: var(--navy); transition: opacity 120ms ease; }
  .highlight .bar { background: var(--orange); }
  .dim .bar { opacity: 0.45; }
  .value { margin-bottom: 6px; color: var(--text); font-size: 12.5px; font-weight: 600; white-space: nowrap; }
  .value.strong { color: var(--orange); }
  .label { margin-top: 8px; color: var(--muted); font-size: 12.5px; white-space: nowrap; }
  .tip { position: absolute; bottom: calc(100% - 30px); left: 50%; z-index: 5; display: grid; gap: 2px; min-width: 120px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); box-shadow: 0 6px 20px rgba(18, 59, 94, 0.12); color: var(--muted); font-size: 12px; text-align: left; transform: translate(-50%, -100%); pointer-events: none; }
  .tip b { color: var(--text); font-size: 13px; }
</style>
