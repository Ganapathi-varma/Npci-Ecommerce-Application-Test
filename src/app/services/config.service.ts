import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class ConfigService {

  // Fallback used by `ng serve` when assets/config.json is absent
  private apiUrlValue = 'https://e-commerce-backend-f8v8.onrender.com/'

  get apiUrl(){
    return this.apiUrlValue
  }

  load(): Promise<void>{
    return fetch('assets/config.json', { cache: 'no-store' })
    .then((res)=> res.ok ? res.json() : null)
    .then((config)=>{
      if(config && typeof config.apiUrl === 'string' && config.apiUrl){
        this.apiUrlValue = config.apiUrl.endsWith('/') ? config.apiUrl : `${config.apiUrl}/`
      }
    })
    .catch(()=>{})
  }
}
