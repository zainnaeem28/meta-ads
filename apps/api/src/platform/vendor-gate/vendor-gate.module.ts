import { Inject, Injectable, Module } from '@nestjs/common';
import type { DynamicModule, OnModuleInit } from '@nestjs/common';
import { VendorGate } from './gate.js';
import { loadRegister } from './register.js';
import type { VendorRegister } from './register.js';

export const VENDOR_GATE = Symbol('VENDOR_GATE');

@Injectable()
class VendorGateStartup implements OnModuleInit {
  constructor(@Inject(VENDOR_GATE) private readonly gate: VendorGate) {}

  /** Fails the process start when any vendor is `real` without a recorded contract. */
  onModuleInit(): void {
    this.gate.assertStartup();
  }
}

@Module({})
export class VendorGateModule {
  static register(
    env: Readonly<Record<string, string | undefined>> = process.env,
    register: VendorRegister = loadRegister(),
  ): DynamicModule {
    return {
      module: VendorGateModule,
      global: true,
      providers: [{ provide: VENDOR_GATE, useValue: new VendorGate(register, env) }, VendorGateStartup],
      exports: [VENDOR_GATE],
    };
  }
}
