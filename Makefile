all:
	latexmk -xelatex -pvc main.tex
upload:
	rm main.fdb_latexmk main.fls main.log main.nav main.out main.snm main.toc main.vrb main.xdv
	mv main.pdf stravaCourse.pdf
