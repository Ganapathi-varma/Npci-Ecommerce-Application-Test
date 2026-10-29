import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';

import { sellerAuthGuard } from './seller-auth.guard';
import { SellerSignupService } from '../services/seller-signup.service';

describe('sellerAuthGuard', () => {
  let guard: sellerAuthGuard;
  let service: SellerSignupService;
  const route = {} as ActivatedRouteSnapshot;
  const state = {} as RouterStateSnapshot;

  beforeEach(() => {
    localStorage.removeItem('admin');
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, RouterTestingModule]
    });
    guard = TestBed.inject(sellerAuthGuard);
    service = TestBed.inject(SellerSignupService);
  });

  afterEach(() => localStorage.removeItem('admin'));

  it('should be created', () => {
    expect(guard).toBeTruthy();
  });

  it('allows access when a seller is stored in localStorage', () => {
    localStorage.setItem('admin', JSON.stringify({ _id: '1', accessToken: 'token' }));
    expect(guard.canActivate(route, state)).toBe(true);
  });

  it('falls back to the logged-in stream when no seller is stored', () => {
    expect(guard.canActivate(route, state)).toBe(service.isSellerLoggedIn);
  });
});
