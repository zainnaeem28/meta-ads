import { Inject, Injectable, Module } from '@nestjs/common';
import type { DynamicModule, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { ADAPTER_VENDORS, VendorGate, gateInstance } from './gate.js';
import { loadRegister } from './register.js';
import type { VendorRegister } from './register.js';

export const VENDOR_GATE = Symbol('VENDOR_GATE');

@Injectable()
class VendorGateStartup implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    @Inject(VENDOR_GATE) private readonly gate: VendorGate,
    private readonly discovery: DiscoveryService,
  ) {}

  /** Wraps every vendor adapter the root built so each call re-checks the gate (call-time refusal). */
  onApplicationBootstrap(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (typeof instance !== 'object' || instance === null) continue;
      for (let c: object | null = Object.getPrototypeOf(instance) as object | null; c !== null; c = Object.getPrototypeOf(c) as object | null) {
        const vendor = ADAPTER_VENDORS[(c.constructor as { name: string }).name];
        if (vendor !== undefined) {
          gateInstance(this.gate, vendor, instance);
          break;
        }
      }
    }
  }

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
      imports: [DiscoveryModule],
      global: true,
      providers: [{ provide: VENDOR_GATE, useValue: new VendorGate(register, env) }, VendorGateStartup],
      exports: [VENDOR_GATE],
    };
  }
}
