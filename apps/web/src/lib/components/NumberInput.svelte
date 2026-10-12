<script lang="ts">
  /**
   * Ô nhập số dùng chung: phân cách hàng nghìn ngay khi gõ (vi 1.250.000,5 · zh 1,250,000.5), giữ vị trí con trỏ.
   * `bind:value` luôn là chuỗi chuẩn gửi API ("1250000.5", rỗng khi chưa nhập). Gõ "." hoặc "," ở ô có số lẻ đều là dấu thập phân.
   * Mọi thuộc tính khác (id, class, readonly, aria-*, data-*, onkeydown…) chuyển thẳng vào thẻ input.
   */
  import { untrack } from 'svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { intlLocale } from '$lib/i18n';
  import { canonicalNumber, formatNumberValue, parseLooseNumber, reformatNumberInput, separatorsFor } from '$lib/number-input';

  type Props = Omit<HTMLInputAttributes, 'value' | 'type' | 'inputmode' | 'oninput' | 'onpaste'> & {
    value?: string;
    /** Số chữ số lẻ tối đa (0 = số nguyên). */
    decimals?: number;
    /** Gọi sau mỗi lần giá trị chuẩn đổi do người dùng gõ / dán. */
    onvalue?: (value: string) => void;
    element?: HTMLInputElement;
  };
  // Không đặt giá trị mặc định cho value: Svelte báo lỗi khi bind:value vào thuộc tính đang undefined mà prop có mặc định.
  let { value = $bindable(), decimals = 0, onvalue, element = $bindable(), ...rest }: Props = $props();

  const sep = separatorsFor(intlLocale());
  let display = $state(formatNumberValue(untrack(() => value), sep));

  // Giá trị đổi từ bên ngoài (tải phiếu, đặt lại form) → hiển thị lại; giá trị do chính ô này phát ra thì giữ nguyên chuỗi đang gõ.
  $effect(() => {
    const incoming = canonicalNumber(value);
    untrack(() => {
      if (canonicalNumber(reformatNumberInput(display, 0, Math.max(decimals, 8), sep).value) !== incoming) display = formatNumberValue(value, sep);
    });
  });

  function commit(input: HTMLInputElement, text: string, caret: number) {
    const result = reformatNumberInput(text, caret, decimals, sep);
    display = result.text;
    input.value = result.text;
    if (document.activeElement === input) input.setSelectionRange(result.caret, result.caret);
    if (result.value !== value) {
      value = result.value;
      onvalue?.(result.value);
    }
  }

  function handleInput(event: Event & { currentTarget: HTMLInputElement }) {
    const input = event.currentTarget;
    const inputEvent = event as unknown as InputEvent;
    let text = input.value;
    let caret = input.selectionStart ?? text.length;
    const inserted = inputEvent.inputType?.startsWith('insert') ? inputEvent.data ?? '' : '';
    if (inserted.length > 1 && caret >= inserted.length) {
      // Chèn cả chuỗi một lần (tự điền, bộ gõ, công cụ kiểm thử) → đọc như chuỗi dán.
      const start = caret - inserted.length;
      const parsed = parseLooseNumber(inserted, decimals).replace('.', sep.decimal);
      text = `${text.slice(0, start)}${parsed}${text.slice(caret)}`;
      caret = start + parsed.length;
    } else if (decimals > 0 && inputEvent.inputType === 'insertText' && (inputEvent.data === '.' || inputEvent.data === ',') && caret > 0) {
      // Dấu vừa gõ là ý định thập phân, dù bàn phím cho "." hay ",".
      text = `${text.slice(0, caret - 1)}${sep.decimal}${text.slice(caret)}`;
    } else if (inputEvent.inputType === 'deleteContentBackward' && display.length - text.length === 1 && display[caret] === sep.group) {
      // Xóa lùi đúng dấu phân cách → xóa luôn chữ số đứng trước nó.
      text = `${text.slice(0, Math.max(0, caret - 1))}${text.slice(caret)}`;
      caret = Math.max(0, caret - 1);
    } else if (inputEvent.inputType === 'deleteContentForward' && display.length - text.length === 1 && display[caret] === sep.group) {
      text = `${text.slice(0, caret)}${text.slice(caret + 1)}`;
    }
    commit(input, text, caret);
  }

  function handlePaste(event: ClipboardEvent & { currentTarget: HTMLInputElement }) {
    const pasted = event.clipboardData?.getData('text') ?? '';
    if (!pasted) return;
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const parsed = parseLooseNumber(pasted, decimals).replace('.', sep.decimal);
    const text = `${input.value.slice(0, start)}${parsed}${input.value.slice(end)}`;
    commit(input, text, start + parsed.length);
  }
</script>

<input
  {...rest}
  bind:this={element}
  type="text"
  inputmode={decimals > 0 ? 'decimal' : 'numeric'}
  autocomplete="off"
  value={display}
  oninput={handleInput}
  onpaste={handlePaste}
/>
