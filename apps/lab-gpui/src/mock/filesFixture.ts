import mainSource from "./main.tsx?raw";
import fixturesSource from "./fixtures.ts?raw";

export interface FileLocation {
  path: string;
  start: number;
  end: number;
}

export interface FileSelection extends FileLocation {
  text: string;
}

const controllerPath = "app/Http/Controllers/OrderController.php";
const modelPath = "app/Models/Order.php";
const viewPath = "resources/views/orders/show.blade.php";

export const walkthroughStart: FileLocation = { path: controllerPath, start: 16, end: 20 };
export const walkthroughReveal: FileLocation = { path: viewPath, start: 8, end: 10 };
const classDefinition: FileLocation = { path: modelPath, start: 8, end: 8 };
const totalDefinition: FileLocation = { path: modelPath, start: 14, end: 17 };

export const fileSources: Record<string, string> = {
  [controllerPath]: `<?php

declare(strict_types=1);

namespace App\\Http\\Controllers;

use App\\Models\\Order;
use Illuminate\\Contracts\\View\\View;

final class OrderController extends Controller
{
    public function show(Order $order): View
    {
        $order->loadMissing('items');

        $total = $order->totalInCents();

        return view('orders.show', [
            'order' => $order,
            'total' => $total,
        ]);
    }
}
`,
  [modelPath]: `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Database\\Eloquent\\Relations\\HasMany;

final class Order extends Model
{
    public function items(): HasMany
    {
        return $this->hasMany(OrderItem::class);
    }
    public function totalInCents(): int
    {
        return (int) $this->items->sum('subtotal_cents');
    }
}
`,
  [viewPath]: `<x-app-layout>
    <article>
        <h1>Order #{{ $order->number }}</h1>

        <dl>
            <dt>Customer</dt>
            <dd>{{ $order->customer_name }}</dd>
            <dt>Total</dt>
            <dd>
                {{ number_format($total / 100, 2) }}
            </dd>
        </dl>
    </article>
</x-app-layout>
`,
  "mock/main.tsx": mainSource,
  "mock/fixtures.ts": fixturesSource,
};

export function definitionFor(path: string, token: string) {
  if (path !== controllerPath) return undefined;
  if (token === "'orders.show'") return walkthroughReveal;
  if (token === "Order") return classDefinition;
  if (token === "totalInCents") return totalDefinition;
  return undefined;
}
