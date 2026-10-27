import { CatalogDeleteError } from './api';

/** Russian plural: ru(1,'заказ','заказа','заказов') → 'заказ'. */
export function ru(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const inOrders = (n: number | undefined) =>
  n && n > 0 ? `в ${n} ${ru(n, 'заказе', 'заказах', 'заказах')}` : 'в заказах';

export type DeleteEntity = 'product' | 'variant' | 'category';

/**
 * What the owner sees when the server refuses a delete. `suggest` names the safe alternative the dialog offers
 * (archive / deactivate / move products); `gone` means the row no longer exists and the list must be refreshed.
 */
export interface DeleteExplanation {
  code: string;
  text: string;
  suggest: 'archive' | 'deactivate' | 'move' | null;
  gone: boolean;
}

export function explainDeleteError(e: unknown, entity: DeleteEntity): DeleteExplanation {
  const code = e instanceof CatalogDeleteError ? e.code : '';
  return { code, ...explain(code, e instanceof CatalogDeleteError ? e.details : {}, entity) };
}

function explain(code: string, d: Record<string, number>, entity: DeleteEntity): Omit<DeleteExplanation, 'code'> {
  switch (code) {
    case 'product_has_orders':
      return {
        text: `Товар нельзя удалить: он уже есть ${inOrders(d.orders)}, и удаление повредило бы историю продаж. Отправьте его в архив — он исчезнет с витрины, а заказы останутся без изменений.`,
        suggest: 'archive',
        gone: false,
      };
    case 'variant_has_orders':
      return {
        text: `Вариант нельзя удалить: он уже есть ${inOrders(d.orders)}, и удаление повредило бы историю продаж. Выключите его — он исчезнет с витрины, а заказы останутся без изменений.`,
        suggest: 'deactivate',
        gone: false,
      };
    case 'last_variant':
      return {
        text: 'Это единственный вариант товара, а у товара должен остаться хотя бы один. Добавьте другой вариант или удалите (архивируйте) сам товар.',
        suggest: null,
        gone: false,
      };
    case 'category_has_products': {
      const n = d.products;
      return {
        text: n
          ? `В категории ${n} ${ru(n, 'товар', 'товара', 'товаров')} (включая архивные). Выберите категорию, в которую их перенести, или отправьте категорию в архив.`
          : 'В категории есть товары. Выберите категорию, в которую их перенести, или отправьте категорию в архив.',
        suggest: 'move',
        gone: false,
      };
    }
    case 'target_not_found':
      return { text: 'Категория для переноса не найдена или находится в архиве. Выберите другую.', suggest: 'move', gone: false };
    case 'invalid_target':
      return { text: 'Нельзя перенести товары в удаляемую категорию.', suggest: 'move', gone: false };
    case 'product_not_found':
    case 'variant_not_found':
    case 'category_not_found':
      return {
        text:
          entity === 'category'
            ? 'Категория уже удалена или недоступна для вашей учётной записи. Список обновлён.'
            : `${entity === 'product' ? 'Товар' : 'Вариант'} уже удалён или недоступен для вашей учётной записи. Список обновлён.`,
        suggest: null,
        gone: true,
      };
    default:
      return { text: 'Не удалось удалить. Проверьте соединение и повторите попытку.', suggest: null, gone: false };
  }
}
