import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { Product } from '../models/dataTypes';

import { ConfigService } from './config.service';

@Injectable({
  providedIn: 'root'
})
export class ProductsService {

  private config = inject(ConfigService)

  get url(){
    return this.config.apiUrl
  }

  constructor(private http: HttpClient) { }

  getHeaders(){
    let userStore = localStorage.getItem('admin')
    let accessToken = userStore && JSON.parse(userStore).accessToken

    let httpHeaders: HttpHeaders = new HttpHeaders({
      'Content-Type': 'application/json', 
      'Authorization': `Bearer ${accessToken}`
    })

    return httpHeaders

  }

  errorHandler(error: HttpErrorResponse){
    console.log(error);  
    return throwError(error)
  }

  createProduct(productData: Product){
    let Headers = this.getHeaders()
    return this.http.post<Product>(`${this.url}products`, productData, { headers: Headers })
    .pipe(catchError(this.errorHandler))
  }

  getProducts(){
    let Headers = this.getHeaders()
    return this.http.get<Product[]>(`${this.url}products/seller-prod`, { headers: Headers })
    .pipe(catchError(this.errorHandler))
  }

  getProduct(productId: string){
    let Headers = this.getHeaders()
    return this.http.get<Product>(`${this.url}products/${productId}`, { headers: Headers })
    .pipe(catchError(this.errorHandler))
  }

  updateProduct(productData: Product){
    let Headers = this.getHeaders()
    return this.http.put<Product>(`${this.url}products/${productData._id}`, productData, { headers: Headers })
    .pipe(catchError(this.errorHandler))
  }

  deleteProduct(productId: string){
    let Headers = this.getHeaders()
    return this.http.delete<Product>(`${this.url}products/${productId}`, { headers: Headers })
    .pipe(catchError(this.errorHandler))
  }
}
