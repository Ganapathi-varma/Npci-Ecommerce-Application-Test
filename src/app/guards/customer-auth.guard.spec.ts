import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';

import { customerAuthGuard } from './customer-auth.guard';
import { CustomerSignupService } from '../services/customer-signup.service';

describe('customerAuthGuard', () => {
  let guard: customerAuthGuard;
  let service: CustomerSignupService;
  const route = {} as ActivatedRouteSnapshot;
  const state = {} as RouterStateSnapshot;

  beforeEach(() => {
    localStorage.removeItem('customer');
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, RouterTestingModule]
    });
    guard = TestBed.inject(customerAuthGuard);
    service = TestBed.inject(CustomerSignupService);
  });

  afterEach(() => localStorage.removeItem('customer'));

  it('should be created', () => {
    expect(guard).toBeTruthy();
  });

  it('allows access when a customer is stored in localStorage', () => {
    localStorage.setItem('customer', JSON.stringify({ _id: '1', accessToken: 'token' }));
    expect(guard.canActivate(route, state)).toBe(true);
  });

  it('falls back to the logged-in stream when no customer is stored', () => {
    expect(guard.canActivate(route, state)).toBe(service.isCustomerLoggedIn);
  });
});
