import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';

import { CustomerSignupService } from './customer-signup.service';

describe('CustomerSignupService', () => {
  let service: CustomerSignupService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, RouterTestingModule]
    });
    service = TestBed.inject(CustomerSignupService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
