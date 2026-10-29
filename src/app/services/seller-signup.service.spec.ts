import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';

import { SellerSignupService } from './seller-signup.service';

describe('SellerSignupService', () => {
  let service: SellerSignupService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, RouterTestingModule]
    });
    service = TestBed.inject(SellerSignupService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
