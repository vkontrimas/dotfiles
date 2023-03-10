call plug#begin('~/.config/nvim/plugged')
Plug 'tpope/vim-surround'
Plug 'morhetz/gruvbox'
Plug 'junegunn/fzf.vim'
Plug 'junegunn/fzf'
Plug 'rhysd/vim-clang-format'
call plug#end()

colorscheme gruvbox

set nu
set rnu

set tabstop=2
set shiftwidth=2
set expandtab
set foldcolumn=2

nnoremap <leader>h <C-W>h
nnoremap <leader>j <C-W>j
nnoremap <leader>k <C-W>k
nnoremap <leader>l <C-W>l

nnoremap <leader>b :b#<CR>

nnoremap <leader>f :Files<CR>
nnoremap <leader>r :Rg<CR>
nnoremap <leader>t :BLines<CR>
nnoremap <leader>g :Buffers<CR>

let g:clang_format#auto_format = 1
nmap <Leader>C :ClangFormatAutoToggle<CR>
